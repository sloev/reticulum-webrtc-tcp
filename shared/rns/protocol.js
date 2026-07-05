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
export const CONTEXT_RESOURCE = 0x01;
export const CONTEXT_RESOURCE_ADV = 0x02;
export const CONTEXT_RESOURCE_REQ = 0x03;
export const CONTEXT_RESOURCE_HMU = 0x04;
export const CONTEXT_RESOURCE_PRF = 0x05;
export const CONTEXT_REQUEST = 0x09;
export const CONTEXT_RESPONSE = 0x0a;
export const CONTEXT_PATH_RESPONSE = 0x0b;
export const CONTEXT_CHANNEL = 0x0e;
export const CONTEXT_KEEPALIVE = 0xfa;
export const CONTEXT_LINKIDENTIFY = 0xfb;
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

// Matches RNS.Identity.encrypt(): the same X25519 ECDH + HKDF + AES-256-CBC +
// HMAC-SHA256 token used for single-destination DATA packets, but as a
// standalone operation rather than a full packet — reused as-is for
// encrypting an LXMF message to its recipient before handing it to a
// propagation node for store-and-forward (see propagation.js), where the
// prefixed destination_hash needs to stay outside the ciphertext so the
// propagation node can index by it without being able to read the message.
export function identity_encrypt(plaintext, receiver_identity_pub, receiver_ratchet_pub) {
  const salt = identity_hash(receiver_identity_pub);

  const ephemeral_priv = crypto.private_ratchet();
  const ephemeral_pub = crypto.public_ratchet(ephemeral_priv);

  // Use the announced ratchet if the sender has one, otherwise fall back to
  // the receiver's primary X25519 key.
  const target_pub = (receiver_ratchet_pub && receiver_ratchet_pub.length > 0)
      ? receiver_ratchet_pub
      : receiver_identity_pub.slice(0, 32);

  const shared_secret = crypto.x25519_exchange(ephemeral_priv, target_pub);
  const derived_key = crypto.hkdf(shared_secret, 64, salt);

  const iv = crypto.randomBytes(16);
  const ciphertext = crypto.aes_cbc_encrypt(derived_key.slice(32), iv, plaintext);

  const signed_data = crypto.concat(iv, ciphertext);
  const message_hmac = crypto.hmac_sha256(derived_key.slice(0, 32), signed_data);

  return crypto.concat(ephemeral_pub, signed_data, message_hmac);
}

export function build_data(plaintext, receiver_identity_pub, receiver_ratchet_pub, full_name) {
  const destination_hash = get_identity_destination_hash(receiver_identity_pub, full_name);
  const data = identity_encrypt(plaintext, receiver_identity_pub, receiver_ratchet_pub);

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

// RNS.Link.identify(): the initiator proves their real identity to the
// responder over an already-established (and thus already-encrypted) link —
// an opt-in authentication step distinct from the link handshake itself
// (which never reveals either side's identity). Only the initiator may call
// this (real RNS also restricts it that way); the payload is the identity's
// full 64-byte public key plus an Ed25519 signature (using that same
// identity's signing key) over `link_id + public_key`, wrapped and encrypted
// like ordinary link data (build_link_packet(..., CONTEXT_LINKIDENTIFY)).
export function build_link_identify_payload(link_id, identity_priv) {
    const identity_pub = crypto.public_identity(identity_priv);
    const signed_data = crypto.concat(link_id, identity_pub);
    const signature = crypto.ed25519_sign(identity_priv.slice(32), signed_data);
    return crypto.concat(identity_pub, signature);
}

// Returns the revealed 64-byte identity public key if the signature over
// `link_id + identity_pub` checks out, otherwise null.
export function parse_link_identify_payload(link_id, plaintext) {
    if (plaintext.length !== 64 + 64) return null;
    const identity_pub = plaintext.slice(0, 64);
    const signature = plaintext.slice(64, 128);
    const signed_data = crypto.concat(link_id, identity_pub);
    if (!crypto.ed25519_validate(signature, signed_data, identity_pub.slice(32, 64))) return null;
    return identity_pub;
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

// --- RNS.Resource (chunked large-transfer protocol over a Link) ---
// Transfers larger than one segment's worth (RESOURCE_SEGMENT_MAX_SIZE) are
// split into multiple segments — each with its own independent advertise/
// request/part/proof cycle (a fresh resourceHash and random_hash per
// segment), linked only by a shared "original_hash" (the first segment's own
// resourceHash) and 1-based segment_index/total_segments fields — same idea
// as real RNS.Resource's segmenting, just at a much smaller per-segment size
// (see RESOURCE_MAX_PARTS's comment for why). Sending a large payload this
// way to a real RNS peer works (it just processes whatever segment size we
// advertise); *receiving* one from a real peer only works up to one segment
// still, since a real sender only segments past 1MiB-1 and a segment that
// large needs RNS's HMU packets (splitting a hashmap across more than one
// packet) to receive, which isn't implemented. No *outgoing* compression
// either (real RNS bz2-compresses by default when it shrinks the payload;
// this project's sender never does, since it has no need to — see
// shared/rns/compression.js for why decoding a real peer's compressed
// transfer is still supported).
// The receiver requests parts in a fixed-size window (see
// index.js's Link._requestNextResourceParts()) rather than RNS.Resource's
// adaptive window (which grows from a small starting size up toward a much
// larger one on a fast, well-behaved link, tuned for lossy shared-bandwidth
// radio links) — a real RNS sender doesn't care how a receiver paces its
// requests (it just resends whatever's asked for from its own already-built
// part list, unconditionally), so this fixed window is enough for genuine
// interop with a real RNS peer in either direction, just without RNS's
// throughput ramp-up on fast links. Also not implemented: retrying a request
// after a timeout with no response, since this project's transports (WebRTC
// data channels, TCP) are already reliable and ordered, unlike the lossy
// radio links that timeout/retry logic is for. The wire primitives —
// advertisement, request, part, and proof packets, and the hashing scheme
// that ties them together — match RNS.Resource/ResourceAdvertisement's
// format and context bytes exactly. See README's Compliance section.
// Bytes available per Link packet in general (Channel, Request/Response) —
// matches RNS.Link's own `self.mdu` instance attribute exactly (with RNS's
// default Reticulum.MTU=500), computed the same way RNS.Link.handshake()
// does: floor((MTU-IFAC_MIN_SIZE-HEADER_MINSIZE-TOKEN_OVERHEAD)/
// AES128_BLOCKSIZE)*AES128_BLOCKSIZE - 1.
//
// This is a *different*, smaller value than RESOURCE_SDU below — real RNS
// computes them differently (Resource.sdu doesn't use this AES-block-
// rounded formula at all, see below), a distinction easy to miss since both
// are "the per-packet payload budget" in spirit. Conflating them silently
// produced a resource part-count mismatch that only showed up once a
// transfer's part count crossed a boundary where the two formulas disagree
// (found via live testing with a large multi-segment transfer — small
// transfers happened to land on the same part count either way).
export const LINK_MDU = Math.floor((500 - 1 - 19 - 48) / 16) * 16 - 1;
export const RESOURCE_MAPHASH_LEN = 4;
export const RESOURCE_RANDOM_HASH_LEN = 4;
// Matches RNS.ResourceAdvertisement.HASHMAP_MAX_LEN: how many map hashes fit
// in one advertisement packet, bounded by the link MDU. A transfer with more
// parts than this needs HMU (hashmap update) packets to deliver the rest of
// the hashmap incrementally — see Link._onResourceAdvertisement/_onHashmapUpdate.
export const RESOURCE_HASHMAP_MAX_LEN = Math.floor((LINK_MDU - 134) / RESOURCE_MAPHASH_LEN);
// Bytes per Resource part packet. Matches RNS.Resource.sdu exactly (with
// RNS's default Reticulum.MTU=500 and no IFAC): `self.link.mtu -
// HEADER_MAXSIZE - IFAC_MIN_SIZE` — notably *not* AES-block-rounded, unlike
// LINK_MDU above. This has to match exactly, not just fit under some
// conservative bound: a real RNS receiver computes total_parts as
// ceil(transfer_size / its own resource.sdu) independently, without reading
// this project's `n` (part count) advertisement field at all — a mismatched
// SDU makes the two sides disagree on how many parts there are, and RNS
// silently drops the whole transfer as corrupt.
export const RESOURCE_SDU = 500 - 35 - 1;
// Caps a single *segment* on the send side: this project's own sender always
// includes the whole hashmap in the initial advertisement packet rather than
// truncating it to RESOURCE_HASHMAP_MAX_LEN and sending the rest via HMU
// packets on request (both a real receiver and this project's own receiver
// tolerate an advertisement's hashmap being larger than what real RNS itself
// would ever send in one packet — the size limit is a real-RNS sender-side
// packing choice, not a receiver-side validation rule). Real RNS instead
// segments once transfer size exceeds MAX_EFFICIENT_SIZE (1MiB-1) — this
// project segments much smaller and more often, at this per-segment
// part-count limit. Receiving a segment larger than this from a *real* RNS
// sender (which does truncate its hashmap and expects HMU requests) is
// supported — see Link._onResourceAdvertisement/_onHashmapUpdate.
export const RESOURCE_MAX_PARTS = 128;
// The largest raw (pre-encryption) plaintext chunk that's guaranteed to fit
// within RESOURCE_MAX_PARTS parts after the random-hash prefix, PKCS7
// padding, and the link Token's IV+HMAC overhead — see resource_prepare().
export const RESOURCE_SEGMENT_MAX_SIZE = RESOURCE_MAX_PARTS * RESOURCE_SDU - 128;
// Matches RNS.Resource's rate-adaptive request window (RNS/Resource.py):
// starts small and grows by 1 each round the previous window was fully
// satisfied, up to window_max — which itself starts modest and is promoted
// to RESOURCE_WINDOW_MAX_FAST once the measured transfer rate has been
// "fast" for RESOURCE_FAST_RATE_THRESHOLD consecutive rounds (or demoted to
// RESOURCE_WINDOW_MAX_VERY_SLOW if it's been "very slow" instead). See
// Link._requestNextResourceParts()/_onResourcePart() in index.js.
export const RESOURCE_WINDOW = 4;
export const RESOURCE_WINDOW_MIN = 2;
export const RESOURCE_WINDOW_MAX_SLOW = 10;
export const RESOURCE_WINDOW_MAX_VERY_SLOW = 4;
export const RESOURCE_WINDOW_MAX_FAST = 75;
export const RESOURCE_WINDOW_FLEXIBILITY = 4;
export const RESOURCE_RATE_FAST = (50 * 1000) / 8; // bytes/sec (50kbit/s)
export const RESOURCE_RATE_VERY_SLOW = (2 * 1000) / 8; // bytes/sec (2kbit/s)
export const RESOURCE_FAST_RATE_THRESHOLD = RESOURCE_WINDOW_MAX_SLOW - RESOURCE_WINDOW - 2;
export const RESOURCE_VERY_SLOW_RATE_THRESHOLD = 2;

export function resource_map_hash(part_data, random_hash) {
    return crypto.sha256(crypto.concat(part_data, random_hash)).slice(0, RESOURCE_MAPHASH_LEN);
}

// Encrypts and slices one segment's `plaintext` into parts for a Link
// Resource transfer, and computes the values both sides need to identify
// parts and verify that segment completed intact. `link_encrypt_fn` is
// usually `(data) => link_encrypt(link.derivedKey, data)`. Throws if this
// segment alone would need more than RESOURCE_MAX_PARTS parts — callers
// transferring more than RESOURCE_SEGMENT_MAX_SIZE bytes are expected to
// call this once per segment (see index.js's Link.sendResource()).
//
// `compressed`/`sendData` let a caller pass in an already bz2-compressed
// version of `plaintext` to actually encrypt and send (see
// compression.js's bz2_compress_if_beneficial(), which decides whether
// compressing was worthwhile) — matching real RNS.Resource, the resource's
// hash/proof/dataSize are always computed over the original, uncompressed
// `plaintext` regardless, since compression is purely a transport-level
// optimization transparent to the resource's own identity.
export function resource_prepare(plaintext, link_encrypt_fn, { compressed = false, sendData = plaintext } = {}) {
    const embeddedSalt = crypto.randomBytes(RESOURCE_RANDOM_HASH_LEN);
    const cipherBlob = link_encrypt_fn(crypto.concat(embeddedSalt, sendData));

    const totalParts = Math.max(1, Math.ceil(cipherBlob.length / RESOURCE_SDU));
    if (totalParts > RESOURCE_MAX_PARTS) {
        throw new Error(`Resource of ${sendData.length} bytes needs ${totalParts} parts, exceeding the ${RESOURCE_MAX_PARTS}-part single-segment limit (see README's Compliance section)`);
    }

    const randomHash = crypto.randomBytes(RESOURCE_RANDOM_HASH_LEN);
    const resourceHash = crypto.sha256(crypto.concat(plaintext, randomHash));
    const expectedProof = crypto.sha256(crypto.concat(plaintext, resourceHash));

    const parts = [];
    const hashmapEntries = [];
    for (let i = 0; i < totalParts; i++) {
        const partData = cipherBlob.slice(i * RESOURCE_SDU, (i + 1) * RESOURCE_SDU);
        parts.push(partData);
        hashmapEntries.push(resource_map_hash(partData, randomHash));
    }

    return {
        randomHash, resourceHash, expectedProof, parts, hashmapEntries, compressed,
        hashmap: crypto.concat(...hashmapEntries),
        totalParts, transferSize: cipherBlob.length, dataSize: plaintext.length,
    };
}

// Matches ResourceAdvertisement's msgpack field layout ({t,d,n,h,r,o,i,l,q,f,m}).
// f (flags) sets the "encrypted" bit (always, this project always encrypts),
// the "split" bit when totalSegments > 1, and the "compressed" bit when the
// sender bz2-compressed this segment's data, matching
// `0x00 | has_metadata<<5 | is_response<<4 | is_request<<3 | split<<2 |
// compressed<<1 | encrypted` — has_metadata/is_response/is_request aren't
// implemented on send, so those bits are always 0. i (segment_index) and l
// (total_segments) are 1-based in real RNS — a receiver only treats a
// resource as fully concluded once segment_index == total_segments, so a
// single (first-and-only) segment must be numbered 1, not 0. originalHash
// defaults to resourceHash (matching a first/only segment); a later segment
// passes the *first* segment's resourceHash here instead, linking it back
// to the same overall transfer.
export function build_resource_advertisement({
    transferSize, dataSize, totalParts, resourceHash, randomHash, hashmap,
    segmentIndex = 1, totalSegments = 1, originalHash = resourceHash, compressed = false,
}) {
    const split = totalSegments > 1 ? 0x04 : 0x00;
    const compressedFlag = compressed ? 0x02 : 0x00;
    const dict = {
        t: transferSize, d: dataSize, n: totalParts,
        h: resourceHash, r: randomHash, o: originalHash,
        i: segmentIndex, l: totalSegments, q: null, f: 0x01 | split | compressedFlag, m: hashmap,
    };
    return lxmfMsgpack.pack(dict);
}

export function parse_resource_advertisement(data) {
    const dict = lxmfMsgpack.unpack(data);
    const flags = dict.f;
    return {
        transferSize: dict.t, dataSize: dict.d, totalParts: dict.n,
        resourceHash: dict.h, randomHash: dict.r, originalHash: dict.o,
        segmentIndex: dict.i, totalSegments: dict.l, requestId: dict.q,
        encrypted: (flags & 0x01) === 0x01,
        compressed: ((flags >> 1) & 0x01) === 0x01,
        split: ((flags >> 2) & 0x01) === 0x01,
        hasMetadata: ((flags >> 5) & 0x01) === 0x01,
        hashmap: dict.m,
    };
}

// Matches Resource.request_next()'s request_data layout: a hashmap-exhausted
// flag byte (0xff + the last known map hash, when this receiver has used up
// every hashmap entry it's been sent and needs more via HMU; 0x00 otherwise)
// + the resource hash + the requested map hashes concatenated.
export function build_resource_request(resource_hash, requested_hashes, { lastMapHash = null } = {}) {
    const prefix = lastMapHash ? crypto.concat(new Uint8Array([0xff]), lastMapHash) : new Uint8Array([0x00]);
    return crypto.concat(prefix, resource_hash, requested_hashes);
}

export function parse_resource_request(data) {
    const hashmapExhausted = data[0] === 0xff;
    let offset = 1;
    let lastMapHash = null;
    if (hashmapExhausted) {
        lastMapHash = data.slice(1, 1 + RESOURCE_MAPHASH_LEN);
        offset = 1 + RESOURCE_MAPHASH_LEN;
    }
    const resourceHash = data.slice(offset, offset + 32);
    const requestedHashesRaw = data.slice(offset + 32);
    const requestedHashes = [];
    for (let i = 0; i < requestedHashesRaw.length; i += RESOURCE_MAPHASH_LEN) {
        requestedHashes.push(requestedHashesRaw.slice(i, i + RESOURCE_MAPHASH_LEN));
    }
    return { hashmapExhausted, lastMapHash, resourceHash, requestedHashes };
}

// Matches RNS.Resource's hashmap-update (HMU) packet: resource_hash (32
// bytes) + msgpack([segment_index, hashmap_chunk_bytes]) — sent by a sender
// in response to a request whose hashmap-exhausted flag is set, carrying the
// next chunk of a hashmap too large to fit in the initial advertisement.
export function build_resource_hmu(resource_hash, segment, hashmap_chunk) {
    return crypto.concat(resource_hash, lxmfMsgpack.pack([segment, hashmap_chunk]));
}

export function parse_resource_hmu(data) {
    const resourceHash = data.slice(0, 32);
    const [segment, hashmap] = lxmfMsgpack.unpack(data.slice(32));
    return { resourceHash, segment, hashmap };
}

// Resource part packets carry a raw ciphertext slice, unencrypted at the
// packet level — the whole blob was already encrypted once in
// resource_prepare(), matching RNS.Packet.pack()'s "a resource takes care of
// encryption by itself" special case (context == RESOURCE skips the usual
// per-packet Link Token encryption that build_link_packet() applies).
export function build_resource_part_packet(link_id, part_data) {
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_LINK,
        packet_type: PACKET_DATA, hops: 0, destination_hash: link_id, context: CONTEXT_RESOURCE, data: part_data,
    });
}

export function build_resource_proof(resource_hash, proof_value) {
    return crypto.concat(resource_hash, proof_value);
}

export function parse_resource_proof(data) {
    if (data.length !== 64) return null;
    return { resourceHash: data.slice(0, 32), proofValue: data.slice(32, 64) };
}

// Resource proofs, like Link proofs, aren't encrypted at the packet level
// (RNS.Packet.pack(): "Resource proofs are not encrypted").
export function build_resource_proof_packet(link_id, resource_hash, proof_value) {
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_LINK,
        packet_type: PACKET_PROOF, hops: 0, destination_hash: link_id, context: CONTEXT_RESOURCE_PRF, data: build_resource_proof(resource_hash, proof_value),
    });
}

// --- RNS.Channel (reliable, bidirectional, sequenced messaging over a Link) ---
// Verified byte-for-byte against the real `rns` package: RNS.Channel.Envelope
// wraps every message as struct.pack(">HHH", msgtype, sequence, len(data)) +
// data — a plain 6-byte big-endian header, no further framing. The envelope
// itself is then sent as an ordinary Link packet (build_link_packet(),
// CONTEXT_CHANNEL), so it's encrypted exactly like any other Link app-data
// packet.
//
// A real Channel's MDU is `link.mdu - 6`; see LINK_MDU's definition above
// for why that's a different value than RESOURCE_SDU.
export const CHANNEL_HEADER_SIZE = 6;

export function build_channel_envelope(msgtype, sequence, data) {
    const payload = data || new Uint8Array(0);
    const header = new Uint8Array(CHANNEL_HEADER_SIZE);
    const view = new DataView(header.buffer);
    view.setUint16(0, msgtype, false);
    view.setUint16(2, sequence, false);
    view.setUint16(4, payload.length, false);
    return crypto.concat(header, payload);
}

export function parse_channel_envelope(raw) {
    if (raw.length < CHANNEL_HEADER_SIZE) return null;
    const view = new DataView(raw.buffer, raw.byteOffset, raw.length);
    const msgtype = view.getUint16(0, false);
    const sequence = view.getUint16(2, false);
    const length = view.getUint16(4, false);
    if (raw.length < CHANNEL_HEADER_SIZE + length) return null;
    return { msgtype, sequence, data: raw.slice(CHANNEL_HEADER_SIZE, CHANNEL_HEADER_SIZE + length) };
}

// Explicit packet-level delivery proof (RNS.Packet.prove()/Link.prove_packet()
// on the receiver, RNS.PacketReceipt.validate_proof_packet() on the sender).
// In real RNS this is only ever triggered by Channel traffic (Link.receive()'s
// CHANNEL case calls packet.prove() unconditionally whenever a channel is
// open) — unlike RESOURCE_PRF (an HMAC-style proof over a shared secret) or
// the destination-level identity.prove() used for LXMF opportunistic
// delivery, this is a plain Ed25519 signature over the packet's own full
// hash, signed with the link's own signing key (see shared/rns/index.js's
// Link constructor for why that key is ephemeral for an initiator but the
// real destination identity key for a responder) and verified against the
// peer's link signing public key.
export function build_link_packet_proof(link_id, packet_hash, sig_priv) {
    const signature = crypto.ed25519_sign(sig_priv, packet_hash);
    return packet_pack({
        header_type: 0, context_flag: 0, transport_type: 0, destination_type: DEST_LINK,
        packet_type: PACKET_PROOF, hops: 0, destination_hash: link_id, context: CONTEXT_NONE,
        data: crypto.concat(packet_hash, signature),
    });
}

export function validate_link_packet_proof(proof_packet, peer_sig_pub) {
    if (proof_packet.data.length !== 32 + 64) return null;
    const packet_hash = proof_packet.data.slice(0, 32);
    const signature = proof_packet.data.slice(32, 96);
    if (!crypto.ed25519_validate(signature, packet_hash, peer_sig_pub)) return null;
    return packet_hash;
}

// --- RNS.Buffer (raw byte-stream reader/writer built on top of Channel) ---
// Verified byte-for-byte against the real `rns` package: StreamDataMessage
// uses Channel's system-reserved MSGTYPE 0xff00, and packs a 2-byte
// big-endian header (14-bit stream_id, then an eof flag at bit 15 and a
// compressed flag at bit 14) followed by raw chunk data.
//
// A `compressed` chunk (real RNS bz2-compresses a chunk when doing so
// shrinks it) is decompressed on receive (see shared/rns/compression.js and
// shared/rns/buffer.js's RawChannelReader) — this project's own writer just
// never sets the flag, since it has no need to compress outgoing data.
export const CHANNEL_MSGTYPE_STREAM_DATA = 0xff00;
export const STREAM_ID_MAX = 0x3fff;
export const STREAM_DATA_OVERHEAD = 2 + CHANNEL_HEADER_SIZE; // header + channel envelope
export const STREAM_DATA_MAX_LEN = LINK_MDU - STREAM_DATA_OVERHEAD;
// Matches RawChannelWriter.MAX_CHUNK_LEN: the cap real RNS uses both for how
// much of a single write() call it'll compress at once, and as the
// decompression-bomb guard when unpacking a received compressed chunk.
export const STREAM_DATA_MAX_CHUNK_LEN = 1024 * 16;

export function build_stream_data_message(stream_id, data, eof = false, compressed = false) {
    const payload = data || new Uint8Array(0);
    const header_val = (stream_id & STREAM_ID_MAX) | (eof ? 0x8000 : 0) | (compressed ? 0x4000 : 0);
    const header = new Uint8Array(2);
    new DataView(header.buffer).setUint16(0, header_val, false);
    return crypto.concat(header, payload);
}

export function parse_stream_data_message(raw) {
    if (raw.length < 2) return null;
    const header_val = new DataView(raw.buffer, raw.byteOffset, raw.length).getUint16(0, false);
    return {
        stream_id: header_val & STREAM_ID_MAX,
        eof: (header_val & 0x8000) !== 0,
        compressed: (header_val & 0x4000) !== 0,
        data: raw.slice(2),
    };
}
