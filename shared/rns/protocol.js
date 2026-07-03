import * as crypto from './crypto.js';
import { pack, unpack } from 'msgpackr';

export const PACKET_DATA = 0x00;
export const PACKET_ANNOUNCE = 0x01;
export const PACKET_LINKREQUEST = 0x02;
export const PACKET_PROOF = 0x03;

export const DEST_SINGLE = 0x00;
export const DEST_GROUP = 0x01;
export const DEST_PLAIN = 0x02;
export const DEST_LINK = 0x03;

export const CONTEXT_NONE = 0x00;
export const CONTEXT_LRRTT = 0xfe;
export const CONTEXT_LRPROOF = 0xff;

// Matches RNS.Identity.truncated_hash(identity_pub): sha256(pubkey)[:16].
// This is RNS's "identity hash", distinct from a destination hash.
export function identity_hash(identity_pub) {
    return crypto.sha256(identity_pub).slice(0, 16);
}

export function name_hash(full_name) {
    return crypto.sha256(new TextEncoder().encode(full_name)).slice(0, 10);
}

// Matches RNS.Destination.hash(): sha256(name_hash + identity_hash)[:16].
// Verified byte-for-byte against the reference `rns` package (destination
// hash, announce signed_data/signature, and packet bytes all matched for a
// fixed test identity).
export function get_identity_destination_hash(identity_pub, full_name) {
    return crypto.sha256(crypto.concat(name_hash(full_name), identity_hash(identity_pub))).slice(0, 16);
}

// Matches Python's int(time.time()).to_bytes(5, "big"): a 40-bit big-endian
// Unix timestamp, used as half of an announce's random_hash field.
function timestamp5() {
    let t = Math.floor(Date.now() / 1000);
    const buf = new Uint8Array(5);
    for (let i = 4; i >= 0; i--) {
        buf[i] = t % 256;
        t = Math.floor(t / 256);
    }
    return buf;
}

export function packet_pack(packet) {
  let flags = 0;
  flags |= ((packet.header_type || 0) & 0b1) << 6;
  flags |= ((packet.context_flag || 0) & 0b1) << 5;
  flags |= ((packet.transport_type || 0) & 0b1) << 4;
  flags |= ((packet.destination_type || 0) & 0b11) << 2;
  flags |= (packet.packet_type || 0) & 0b11;

  let result = new Uint8Array([flags, packet.hops || 0]);

  if ((packet.header_type || 0) === 1) {
    result = crypto.concat(result, packet.transport_id);
  }

  result = crypto.concat(result, packet.destination_hash);
  result = crypto.concat(result, new Uint8Array([packet.context || 0]));
  result = crypto.concat(result, packet.data || new Uint8Array(0));

  return result;
}

export function packet_unpack(bytes) {
  if (bytes.length < 19) return null;
  const flags = bytes[0];
  const hops = bytes[1];

  const header_type = (flags >> 6) & 0b1;
  const context_flag = (flags >> 5) & 0b1;
  const transport_type = (flags >> 4) & 0b1;
  const destination_type = (flags >> 2) & 0b11;
  const packet_type = flags & 0b11;

  let offset = 2;
  let transport_id = null;
  if (header_type === 1) {
      if (bytes.length < offset + 16) return null;
      transport_id = bytes.slice(offset, offset + 16);
      offset += 16;
  }

  const destination_hash = bytes.slice(offset, offset + 16);
  offset += 16;
  const context = bytes[offset];
  offset += 1;
  const data = bytes.slice(offset);

  return {
      header_type, context_flag, transport_type, destination_type, packet_type,
      hops, transport_id, destination_hash, context, data
  };
}

export function build_announce(identity_priv, identity_pub, destination_hash, ratchet_priv, ratchet_pub, full_name, app_data = new Uint8Array(0)) {
  const name_hash_bytes = name_hash(full_name);
  // Matches RNS.Identity.get_random_hash()[0:5] + int(time.time()).to_bytes(5, "big").
  const random_hash = crypto.concat(crypto.randomBytes(5), timestamp5());

  const context_flag = ratchet_pub.length > 0 ? 1 : 0;

  const signed_data = crypto.concat(destination_hash, identity_pub, name_hash_bytes, random_hash, ratchet_pub, app_data);
  const signature = crypto.ed25519_sign(identity_priv.slice(32), signed_data);

  let data = crypto.concat(identity_pub, name_hash_bytes, random_hash);
  if (ratchet_pub.length > 0) data = crypto.concat(data, ratchet_pub);
  data = crypto.concat(data, signature, app_data);

  return packet_pack({
      header_type: 0, context_flag, transport_type: 0, destination_type: DEST_SINGLE,
      packet_type: PACKET_ANNOUNCE, hops: 0, destination_hash, context: CONTEXT_NONE, data
  });
}

export function validate_announce(packet) {
  let offset = 0;
  const public_key = packet.data.slice(offset, offset + 64);
  offset += 64;
  const name_hash_bytes = packet.data.slice(offset, offset + 10);
  offset += 10;
  const random_hash = packet.data.slice(offset, offset + 10);
  offset += 10;

  let ratchet = new Uint8Array(0);
  if (packet.context_flag === 1) {
      ratchet = packet.data.slice(offset, offset + 32);
      offset += 32;
  }

  const signature = packet.data.slice(offset, offset + 64);
  offset += 64;
  const app_data = packet.data.slice(offset);

  const signed_data = crypto.concat(packet.destination_hash, public_key, name_hash_bytes, random_hash, ratchet, app_data);
  if (!crypto.ed25519_validate(signature, signed_data, public_key.slice(32))) return false;

  return { public_key, name_hash: name_hash_bytes, random_hash, ratchet, signature, app_data };
}

export function build_data(plaintext, receiver_identity_pub, receiver_ratchet_pub, full_name) {
  const destination_hash = get_identity_destination_hash(receiver_identity_pub, full_name);
  const salt = identity_hash(receiver_identity_pub);

  const ephemeral_priv = crypto.private_ratchet();
  const ephemeral_pub = crypto.public_ratchet(ephemeral_priv);

  // Matches RNS.Identity.encrypt(): use the announced ratchet if the sender
  // has one, otherwise fall back to the receiver's primary X25519 key.
  const target_pub = (receiver_ratchet_pub && receiver_ratchet_pub.length > 0)
      ? receiver_ratchet_pub
      : receiver_identity_pub.slice(0, 32);

  const shared_secret = crypto.x25519_exchange(ephemeral_priv, target_pub);
  const derived_key = crypto.hkdf(shared_secret, 64, salt);

  const iv = crypto.randomBytes(16);
  const ciphertext = crypto.aes_cbc_encrypt(derived_key.slice(32), iv, plaintext);

  const signed_data = crypto.concat(iv, ciphertext);
  const message_hmac = crypto.hmac_sha256(derived_key.slice(0, 32), signed_data);

  const data = crypto.concat(ephemeral_pub, signed_data, message_hmac);

  return packet_pack({
      header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_SINGLE,
      packet_type: PACKET_DATA, hops: 0, destination_hash, context: CONTEXT_NONE, data
  });
}

// `ratchets` should list candidate X25519 private keys to try, in priority
// order. Matches RNS.Identity.decrypt(): try each ratchet, then fall back to
// the receiver's own primary X25519 private key — callers should append that
// key (identity.private.slice(0, 32)) as the last entry in `ratchets`.
export function message_decrypt(packet, receiver_pub, ratchets) {
  if (packet.data.length < 49) return null;
  const salt = identity_hash(receiver_pub);
  const peer_pub = packet.data.slice(0, 32);
  const rest = packet.data.slice(32);
  if (rest.length < 48) return null;

  const signed_data = rest.slice(0, -32);
  const received_hmac = rest.slice(-32);

  for (const ratchet of ratchets) {
      try {
          const derived_key = crypto.hkdf(crypto.x25519_exchange(ratchet, peer_pub), 64, salt);
          const expected_hmac = crypto.hmac_sha256(derived_key.slice(0, 32), signed_data);
          let match = true;
          for (let i = 0; i < 32; i++) if (expected_hmac[i] !== received_hmac[i]) match = false;
          if (match) {
              return crypto.aes_cbc_decrypt(derived_key.slice(32), signed_data.slice(0, 16), signed_data.slice(16));
          }
      } catch (e) {}
  }
  return null;
}

// Mimics LXMF's basic envelope shape (source hash, signature, msgpacked
// [timestamp, title, content, fields]) only. No propagation-node protocol, no
// proof-of-work propagation stamp, no compression/node-sync negotiation — not
// wire-compatible with real LXMF or accepted by official LXMF clients/nodes.
export function lxmf_build(content, source_priv, destination_hash, source_hash, timestamp, title) {
    timestamp = timestamp || Date.now() / 1000;
    title = title || new Uint8Array(0);
    if (typeof title === 'string') title = new TextEncoder().encode(title);
    if (typeof content === 'string') content = new TextEncoder().encode(content);
    if (!source_hash) source_hash = crypto.sha256(crypto.public_identity(source_priv)).slice(0, 16);

    let msgpack_raw = pack([timestamp, title, content, {}]);
    if (!(msgpack_raw instanceof Uint8Array)) msgpack_raw = new Uint8Array(msgpack_raw);

    const message_id = crypto.sha256(crypto.concat(destination_hash, source_hash, msgpack_raw));
    const signed_data = crypto.concat(destination_hash, source_hash, msgpack_raw, message_id);
    const signature = crypto.ed25519_sign(source_priv.slice(32), signed_data);

    return crypto.concat(source_hash, signature, msgpack_raw);
}

export function lxmf_parse(decrypted, destination_hash, sender_pub) {
    if (decrypted.length < 80) return false;
    const source_hash = decrypted.slice(0, 16);
    const signature = decrypted.slice(16, 80);
    const msgpack_raw = decrypted.slice(80);

    try {
        const data = unpack(msgpack_raw);
        if (!data || data.length < 3) return false;

        const message_id = crypto.sha256(crypto.concat(destination_hash, source_hash, msgpack_raw));
        const signed_data = crypto.concat(destination_hash, source_hash, msgpack_raw, message_id);
        const valid = crypto.ed25519_validate(signature, signed_data, sender_pub.slice(32));

        return { source_hash, signature, timestamp: data[0], title: data[1], content: data[2], fields: data[3], valid };
    } catch {
        return false;
    }
}
