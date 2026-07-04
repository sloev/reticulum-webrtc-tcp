import * as crypto from './crypto.js';
import { pack, unpack } from 'msgpackr';
import * as lxmfMsgpack from './msgpack.js';

export const PACKET_DATA = 0x00;
export const PACKET_ANNOUNCE = 0x01;
export const PACKET_LINKREQUEST = 0x02;
export const PACKET_PROOF = 0x03;

export const DEST_SINGLE = 0x00;
export const DEST_GROUP = 0x01;
export const DEST_PLAIN = 0x02;
export const DEST_LINK = 0x03;

export const CONTEXT_NONE = 0x00;
export const CONTEXT_REQUEST = 0x09;
export const CONTEXT_RESPONSE = 0x0a;
export const CONTEXT_PATH_RESPONSE = 0x0b;
export const CONTEXT_KEEPALIVE = 0xfa;
export const CONTEXT_LINKCLOSE = 0xfc;
export const CONTEXT_LRRTT = 0xfe;
export const CONTEXT_LRPROOF = 0xff;

export const TRANSPORT_BROADCAST = 0x00;

// RNS.Link constants (see shared/rns/index.js's Link class).
export const LINK_ECPUBSIZE = 64; // 32-byte X25519 pub + 32-byte Ed25519 pub
export const LINK_MTU_SIZE = 3;
export const LINK_MODE_AES256_CBC = 0x01;
const LINK_MTU_BYTEMASK = 0x1fffff;
const LINK_MODE_BYTEMASK = 0xe0;

// Matches RNS.Identity.truncated_hash(identity_pub): sha256(pubkey)[:16].
// This is RNS's "identity hash", distinct from a destination hash.
export function identity_hash(identity_pub) {
    return crypto.sha256(identity_pub).slice(0, 16);
}

export function name_hash(full_name) {
    return crypto.sha256(new TextEncoder().encode(full_name)).slice(0, 10);
}

// hashable_part is (flags & 0x0F) followed by everything after the hops
// byte — shared by RNS.Packet.get_hash()/getTruncatedHash() and
// RNS.Link.link_id_from_lr_packet(): the hop count is deliberately excluded
// so the hash stays the same as a packet's hops field is incremented in
// transit, while everything else about a relayed link_id or delivery proof
// still ties back to the original packet.
function packet_hashable_part(raw_packet) {
    const flags = raw_packet[0];
    return crypto.concat(new Uint8Array([flags & 0x0f]), raw_packet.slice(2));
}

// Matches RNS.Packet.get_hash(): full (untruncated) SHA-256 of the hashable
// part. Used as the value an explicit/implicit delivery proof signs (see
// build_packet_proof/validate_packet_proof below).
export function packet_full_hash(raw_packet) {
    return crypto.sha256(packet_hashable_part(raw_packet));
}

// Matches RNS.Packet.getTruncatedHash(): sha256(hashable_part)[:16]. Used as
// a Request/Response's request_id (the hash of the packed, encrypted
// REQUEST packet's raw bytes, computed identically by sender and receiver
// since the ciphertext is unchanged in transit).
export function packet_truncated_hash(raw_packet) {
    return packet_full_hash(raw_packet).slice(0, 16);
}

// --- RNS.Packet delivery proofs (Packet.prove()/PacketReceipt.validate_proof()) ---
// Implicit form only (RNS's default: Reticulum.should_use_implicit_proof()),
// where the proof payload is just the destination identity's Ed25519
// signature over the original packet's full hash — no explicit hash needed
// in the payload, since the proof packet's own destination_hash (the first
// 16 bytes of that same hash) is already how the original sender recognizes
// which pending packet this proves. Requires the original sender to already
// know the destination's identity (from an earlier announce), same as
// sending to it in the first place.
export function build_packet_proof(original_packet_full_hash, destination_identity_priv) {
    const signature = crypto.ed25519_sign(destination_identity_priv.slice(32), original_packet_full_hash);
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_SINGLE,
        packet_type: PACKET_PROOF, hops: 0, destination_hash: original_packet_full_hash.slice(0, 16), context: CONTEXT_NONE, data: signature,
    });
}

export function validate_packet_proof(proof_packet, original_packet_full_hash, destination_identity_pub) {
    if (proof_packet.data.length !== 64) return false;
    return crypto.ed25519_validate(proof_packet.data, original_packet_full_hash, destination_identity_pub.slice(32));
}

// Matches RNS.Destination.hash(): sha256(name_hash + identity_hash)[:16].
// Verified byte-for-byte against the reference `rns` package (destination
// hash, announce signed_data/signature, and packet bytes all matched for a
// fixed test identity).
export function get_identity_destination_hash(identity_pub, full_name) {
    return crypto.sha256(crypto.concat(name_hash(full_name), identity_hash(identity_pub))).slice(0, 16);
}

// Matches RNS.Destination.hash() for a PLAIN destination (no identity):
// sha256(name_hash)[:16]. Used for Transport's well-known control
// destinations, like the path request destination below.
export function plain_destination_hash(full_name) {
    return crypto.sha256(name_hash(full_name)).slice(0, 16);
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

export function build_announce(identity_priv, identity_pub, destination_hash, ratchet_priv, ratchet_pub, full_name, app_data = new Uint8Array(0), context = CONTEXT_NONE) {
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
      packet_type: PACKET_ANNOUNCE, hops: 0, destination_hash, context, data
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

// --- RNS.Link wire format ---
// Verified byte-for-byte against the real `rns` package for a full
// initiator/responder handshake: LINKREQUEST packet, link_id, the HKDF
// derived_key, the Ed25519-signed PROOF packet, and the Token-encrypted
// LRRTT/KEEPALIVE/LINKCLOSE/DATA payloads (see shared/rns/index.js's Link
// class and test/rns-compliance.test.js).

// Matches RNS.Link.signalling_bytes(mtu, mode): a 3-byte encoding of the
// link's proposed MTU and encryption mode, packed into the low 21 bits (MTU)
// and bits 21-23 (mode) of a 24-bit big-endian value.
export function link_signalling_bytes(mtu, mode) {
    const signalling_value = (mtu & LINK_MTU_BYTEMASK) + (((mode << 5) & LINK_MODE_BYTEMASK) << 16);
    const buf = new Uint8Array(4);
    new DataView(buf.buffer).setUint32(0, signalling_value, false);
    return buf.slice(1);
}

// Matches RNS.Link.link_id_from_lr_packet(): sha256(hashable_part)[:16],
// where hashable_part is (flags & 0x0F) followed by everything after the
// hops byte, with any trailing MTU-signalling bytes stripped off.
export function link_id_from_request(raw_packet, data_length) {
    const flags = raw_packet[0];
    let hashable_part = crypto.concat(new Uint8Array([flags & 0x0f]), raw_packet.slice(2));
    if (data_length > LINK_ECPUBSIZE) {
        const diff = data_length - LINK_ECPUBSIZE;
        hashable_part = hashable_part.slice(0, hashable_part.length - diff);
    }
    return crypto.sha256(hashable_part).slice(0, 16);
}

// Sent by the initiator, addressed to the destination (not the not-yet-
// existing link) — so destination_type is SINGLE here, not LINK.
export function build_link_request(destination_hash, link_x_pub, link_sig_pub, mtu, mode = LINK_MODE_AES256_CBC) {
    const signalling = link_signalling_bytes(mtu, mode);
    const data = crypto.concat(link_x_pub, link_sig_pub, signalling);
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_SINGLE,
        packet_type: PACKET_LINKREQUEST, hops: 0, destination_hash, context: CONTEXT_NONE, data,
    });
}

export function parse_link_request(packet) {
    if (packet.data.length !== LINK_ECPUBSIZE && packet.data.length !== LINK_ECPUBSIZE + LINK_MTU_SIZE) return null;
    const peer_x_pub = packet.data.slice(0, 32);
    const peer_sig_pub = packet.data.slice(32, 64);
    let mtu = null;
    if (packet.data.length === LINK_ECPUBSIZE + LINK_MTU_SIZE) {
        const b = packet.data.slice(64, 67);
        mtu = ((b[0] << 16) + (b[1] << 8) + b[2]) & LINK_MTU_BYTEMASK;
    }
    return { peer_x_pub, peer_sig_pub, mtu };
}

// Sent by the responder (the destination that accepted the link request),
// signed with the destination identity's real Ed25519 key — not an
// ephemeral per-link key, since the destination's identity is already
// publicly known via its announces.
export function build_link_proof(link_id, destination_identity_priv, own_x_pub, mtu, mode = LINK_MODE_AES256_CBC) {
    const signalling = link_signalling_bytes(mtu, mode);
    const own_sig_pub = crypto.ed25519_pubkey(destination_identity_priv.slice(32));
    const signed_data = crypto.concat(link_id, own_x_pub, own_sig_pub, signalling);
    const signature = crypto.ed25519_sign(destination_identity_priv.slice(32), signed_data);
    const data = crypto.concat(signature, own_x_pub, signalling);

    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_LINK,
        packet_type: PACKET_PROOF, hops: 0, destination_hash: link_id, context: CONTEXT_LRPROOF, data,
    });
}

// Verified on the initiator side against the destination's already-known
// identity (peer_sig_pub comes from the announced identity, not the proof
// packet itself). Returns the peer's link X25519 public key and confirmed
// MTU if the signature is valid, otherwise null.
export function validate_link_proof(packet, link_id, peer_sig_pub) {
    if (packet.data.length !== 64 + 32 + LINK_MTU_SIZE) return null;

    const signature = packet.data.slice(0, 64);
    const peer_x_pub = packet.data.slice(64, 96);
    const signalling = packet.data.slice(96, 99);
    const mtu = ((signalling[0] << 16) + (signalling[1] << 8) + signalling[2]) & LINK_MTU_BYTEMASK;

    const signed_data = crypto.concat(link_id, peer_x_pub, peer_sig_pub, signalling);
    if (!crypto.ed25519_validate(signature, signed_data, peer_sig_pub)) return null;

    return { peer_x_pub, mtu };
}

// Matches RNS.Link.handshake(): ECDH between the two link-ephemeral X25519
// keys, HKDF'd with the link ID as salt (RNS.Link.get_salt()).
export function link_handshake(own_x_priv, peer_x_pub, link_id) {
    return crypto.hkdf(crypto.x25519_exchange(own_x_priv, peer_x_pub), 64, link_id);
}

// Bare Token cipher (no ephemeral key prefix): once a link's derived_key is
// established, both sides already share it, so per-packet payloads don't
// need a fresh ECDH exchange the way single-destination packets do.
export function link_encrypt(derived_key, plaintext) {
    const iv = crypto.randomBytes(16);
    const ciphertext = crypto.aes_cbc_encrypt(derived_key.slice(32), iv, plaintext);
    const signed_data = crypto.concat(iv, ciphertext);
    const message_hmac = crypto.hmac_sha256(derived_key.slice(0, 32), signed_data);
    return crypto.concat(signed_data, message_hmac);
}

export function link_decrypt(derived_key, ciphertext_token) {
    if (ciphertext_token.length < 48) return null;
    const signed_data = ciphertext_token.slice(0, -32);
    const received_hmac = ciphertext_token.slice(-32);
    const expected_hmac = crypto.hmac_sha256(derived_key.slice(0, 32), signed_data);

    let match = true;
    for (let i = 0; i < 32; i++) if (expected_hmac[i] !== received_hmac[i]) match = false;
    if (!match) return null;

    return crypto.aes_cbc_decrypt(derived_key.slice(32), signed_data.slice(0, 16), signed_data.slice(16));
}

// Packs a packet addressed to an established link (destination_type=LINK,
// packet_type=DATA), for KEEPALIVE/LINKCLOSE/LRRTT/app-data contexts. Per
// RNS.Packet.pack(), only KEEPALIVE payloads go out unencrypted — everything
// else on a link is encrypted with the link's Token cipher.
export function build_link_packet(link_id, derived_key, data, context = CONTEXT_NONE) {
    const payload = context === CONTEXT_KEEPALIVE ? data : link_encrypt(derived_key, data);
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_LINK,
        packet_type: PACKET_DATA, hops: 0, destination_hash: link_id, context, data: payload,
    });
}

// --- RNS.Link Request/Response (small-payload form only) ---
// Verified byte-for-byte against the real `rns` package: the request/
// response msgpack envelopes, and that request_id (packet_truncated_hash of
// the packed REQUEST packet) matches on both the sending and receiving side.
// Only the direct-packet form is implemented — RNS falls back to a Resource
// transfer when a request or response doesn't fit in a single packet (over
// the link MDU); that fallback is not implemented here (see README).

export function request_path_hash(path) {
    return crypto.sha256(new TextEncoder().encode(path)).slice(0, 16);
}

// Returns the msgpack-encoded [timestamp, request_path_hash, data] payload;
// wrap it with build_link_packet(link_id, derived_key, payload,
// CONTEXT_REQUEST) and then compute the request_id with
// packet_truncated_hash() on the resulting packed bytes.
export function build_request_payload(path, data, timestamp = Date.now() / 1000) {
    let packed = pack([timestamp, request_path_hash(path), data]);
    if (!(packed instanceof Uint8Array)) packed = new Uint8Array(packed);
    return packed;
}

export function parse_request_payload(plaintext) {
    const [timestamp, path_hash, data] = unpack(Buffer.from(plaintext));
    return { timestamp, path_hash, data };
}

// Returns the msgpack-encoded [request_id, response_data] payload; wrap it
// with build_link_packet(link_id, derived_key, payload, CONTEXT_RESPONSE).
export function build_response_payload(request_id, response_data) {
    let packed = pack([request_id, response_data]);
    if (!(packed instanceof Uint8Array)) packed = new Uint8Array(packed);
    return packed;
}

export function parse_response_payload(plaintext) {
    const [request_id, response_data] = unpack(Buffer.from(plaintext));
    return { request_id, response_data };
}

// --- RNS.Transport: path requests/responses ---
// Verified byte-for-byte against the real `rns` package: the well-known path
// request destination hash, and a full path request packet. Scoped to what's
// needed for single-hop path discovery (announce propagation with correct
// hop counts, and answering/making path requests) — NOT implemented: real
// multi-hop DATA/LINK packet forwarding via next-hop routing tables (would
// require per-neighbor addressing, a further architectural change), transport
// instance identities/HEADER_2 loop detection, or any of RNS.Transport's
// interface-duty-cycle/roaming-mode rate limiting. See README's Compliance
// section.

// RNS.Transport's well-known "rnstransport.path.request" control destination
// — the same fixed hash on every Reticulum network, used to broadcast and
// answer path requests.
export const PATH_REQUEST_DEST_HASH = plain_destination_hash('rnstransport.path.request');

// Matches the non-transport-enabled form of RNS.Transport.request_path():
// destination_hash + a random tag, with no transport instance ID (this
// project has no persistent "transport identity" concept — see above).
export function build_path_request(destination_hash, tag) {
    const data = crypto.concat(destination_hash, tag);
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: TRANSPORT_BROADCAST, destination_type: DEST_PLAIN,
        packet_type: PACKET_DATA, hops: 0, destination_hash: PATH_REQUEST_DEST_HASH, context: CONTEXT_NONE, data,
    });
}

// Matches RNS.Transport.path_request_handler(): the first 16 bytes are
// always the destination hash being looked up; if more bytes follow, RNS
// treats the next 16 as a requesting transport instance ID and the rest as
// the tag, otherwise everything after the destination hash is the tag.
export function parse_path_request(packet) {
    const HASHLEN = 16;
    if (packet.data.length < HASHLEN) return null;
    const destination_hash = packet.data.slice(0, HASHLEN);

    let requesting_transport_id = null;
    let tag = null;
    if (packet.data.length > HASHLEN * 2) {
        requesting_transport_id = packet.data.slice(HASHLEN, HASHLEN * 2);
        tag = packet.data.slice(HASHLEN * 2);
    } else if (packet.data.length > HASHLEN) {
        tag = packet.data.slice(HASHLEN);
    }
    if (tag === null) return null;
    if (tag.length > HASHLEN) tag = tag.slice(0, HASHLEN);

    return { destination_hash, requesting_transport_id, tag };
}

// Matches LXMF's core message envelope byte-for-byte (see LXMF.LXMessage.pack()/
// unpack_from_bytes() in the reference implementation): msgpack([timestamp,
// title, content, fields]) — using shared/rns/msgpack.js rather than msgpackr,
// since msgpackr's int/float and map-size optimizations don't reproduce the
// exact bytes LXMF's Python msgpack (umsgpack) would produce, and the message
// hash/signature are computed over those exact bytes — hashed as
// full_hash(destination_hash + source_hash + msgpack_payload), signed as
// (that hash concatenated onto the hashed part). What's not implemented:
// propagation-node stamps/tickets (LXMF's optional anti-spam proof-of-work),
// the PROPAGATED/PAPER delivery methods, and Resource-based transfer for
// messages too large for a single packet/link MDU — see README.
export function lxmf_build(content, source_priv, destination_hash, source_hash, timestamp, title, fields = {}) {
    timestamp = timestamp || Date.now() / 1000;
    title = title || new Uint8Array(0);
    if (typeof title === 'string') title = new TextEncoder().encode(title);
    if (typeof content === 'string') content = new TextEncoder().encode(content);
    if (!source_hash) source_hash = crypto.sha256(crypto.public_identity(source_priv)).slice(0, 16);

    const payload = [new lxmfMsgpack.Float64(timestamp), title, content, fields];
    const msgpack_raw = lxmfMsgpack.pack(payload);

    const hashed_part = crypto.concat(destination_hash, source_hash, msgpack_raw);
    const message_id = crypto.sha256(hashed_part);
    const signed_data = crypto.concat(hashed_part, message_id);
    const signature = crypto.ed25519_sign(source_priv.slice(32), signed_data);

    // This is the OPPORTUNISTIC wire form: destination_hash is omitted since
    // it's implied by the packet's own (already-encrypted-to) destination.
    return crypto.concat(source_hash, signature, msgpack_raw);
}

export function lxmf_parse(decrypted, destination_hash, sender_pub) {
    if (decrypted.length < 80) return false;
    const source_hash = decrypted.slice(0, 16);
    const signature = decrypted.slice(16, 80);
    const msgpack_raw = decrypted.slice(80);

    try {
        const data = lxmfMsgpack.unpack(msgpack_raw);
        if (!data || data.length < 4) return false;

        const hashed_part = crypto.concat(destination_hash, source_hash, msgpack_raw);
        const message_id = crypto.sha256(hashed_part);
        const signed_data = crypto.concat(hashed_part, message_id);
        const valid = crypto.ed25519_validate(signature, signed_data, sender_pub.slice(32));

        return { source_hash, signature, message_id, timestamp: data[0], title: data[1], content: data[2], fields: data[3], valid };
    } catch {
        return false;
    }
}
