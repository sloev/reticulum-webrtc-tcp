// Verifies shared/rns/* against ground-truth byte vectors generated with the
// real reference implementation (PyPI `rns` 1.3.7), for a fixed test identity
// (private key = bytes 0x00..0x3f). See shared/rns/protocol.js for how each
// value is derived. Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, Destination, Reticulum, Interface, Link } from '../shared/rns/index.js';
import * as protocol from '../shared/rns/protocol.js';
import * as crypto from '../shared/rns/crypto.js';
import { hdlcFrame, HdlcFrameDecoder } from '../node/hdlc.js';
import { unpack } from 'msgpackr';

const TEST_PRIVATE_KEY = crypto.hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
);

test('identity hash matches RNS.Identity.hash', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  assert.equal(crypto.bytesToHex(identity.hash), 'aca31af0441d81dbec71e82da0b4b5f5');
});

test('destination hash matches RNS.Destination.hash for app "webrtc_demo.chat"', () => {
  const rns = new Reticulum();
  rns.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
  const identity = new Identity(TEST_PRIVATE_KEY);
  const dest = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'webrtc_demo', 'chat');
  assert.equal(crypto.bytesToHex(dest.hash), '09a131681a44c130e0dcadb6fa88bd85');
});

test('announce packet matches RNS byte-for-byte with fixed random_hash', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const destHash = protocol.get_identity_destination_hash(identity.public, 'webrtc_demo.chat');

  // Reproduces RNS.Destination.announce()'s random_hash: 5 random bytes +
  // int(time.time()).to_bytes(5, "big"). Fixed here for a deterministic
  // comparison against a captured reference packet (relay/timestamp fixed
  // to random_hash = aaaaaaaaaa00684ee180, i.e. unix time 1750000000).
  const fixedRandomHash = crypto.hexToBytes('aaaaaaaaaa00684ee180');
  const nameHash = protocol.name_hash('webrtc_demo.chat');
  const signedData = crypto.concat(destHash, identity.public, nameHash, fixedRandomHash, new Uint8Array(0), new Uint8Array(0));
  const signature = crypto.ed25519_sign(identity.private.slice(32), signedData);
  const announceData = crypto.concat(identity.public, nameHash, fixedRandomHash, signature, new Uint8Array(0));
  const packet = protocol.packet_pack({
    header_type: 0, context_flag: 0, transport_type: 0, destination_type: protocol.DEST_SINGLE,
    packet_type: protocol.PACKET_ANNOUNCE, hops: 0, destination_hash: destHash, context: protocol.CONTEXT_NONE, data: announceData,
  });

  assert.equal(
    crypto.bytesToHex(packet),
    '010009a131681a44c130e0dcadb6fa88bd85008f40c5adb68f25624ae5b214ea767a6ec94d829d3d7b5e1ad1ba6f3e2138285f29acbae141bccaf0b22e1a94d34d0bc7361e526d0bfe12c89794bc9322966dd7da4891e558e2a931aad6aaaaaaaaaa00684ee180cedff1af4e34c8e5f4177081e854241e7c3fe814dcd9a2cf0c0be6f433a4f5a6cfc98d28216e8a757b30c30b87e0b9b292a6359018ad3c8abae04ecfd8884c02'
  );
});

test('single-destination encrypt/decrypt round-trips without a ratchet (RNS.Identity fallback path)', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const plaintext = new TextEncoder().encode('hello world');

  const packet = protocol.build_data(plaintext, identity.public, new Uint8Array(0), 'webrtc_demo.chat');
  const unpacked = protocol.packet_unpack(packet);

  const decoyRatchet = crypto.private_ratchet();
  const ownX25519Priv = identity.private.slice(0, 32);
  const decrypted = protocol.message_decrypt(unpacked, identity.public, [decoyRatchet, ownX25519Priv]);

  assert.equal(new TextDecoder().decode(decrypted), 'hello world');
});

test('single-destination encrypt/decrypt round-trips with a ratchet', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const plaintext = new TextEncoder().encode('ratchet path');

  const packet = protocol.build_data(plaintext, identity.public, identity.ratchetPublic, 'webrtc_demo.chat');
  const unpacked = protocol.packet_unpack(packet);
  const decrypted = protocol.message_decrypt(unpacked, identity.public, [identity.ratchetPrivate]);

  assert.equal(new TextDecoder().decode(decrypted), 'ratchet path');
});

test('announce -> encrypted send -> decrypt works end to end over a loopback interface', async () => {
  const rns = new Reticulum();
  class Loopback extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => rns.onPacketReceived(data, this), 0); }
  }
  rns.addInterface(new Loopback('loop'));

  const identity = Identity.create();
  const dest = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'test', 'chat');

  const received = new Promise((resolve) => dest.on('packet', (e) => resolve(new TextDecoder().decode(e.data))));
  dest.announce();
  await new Promise((r) => setTimeout(r, 20));

  const out = new Destination(rns, identity, Destination.OUT, Destination.SINGLE, 'test', 'chat');
  out.hash = dest.hash;
  out.send(new TextEncoder().encode('hello world'));

  assert.equal(await received, 'hello world');
});

// --- RNS.Link: ground truth captured from a real rns.Link handshake between
// a fixed test identity (destination owner/responder) and fixed ephemeral
// link keys (initiator X25519 = 0x11*32, initiator Ed25519 seed = 0x22*32,
// responder X25519 = 0x33*32), for destination app "test.link". ---

test('Link request packet and link_id match RNS byte-for-byte', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const destHash = protocol.get_identity_destination_hash(identity.public, 'test.link');

  const linkXAPriv = new Uint8Array(32).fill(0x11);
  const linkXAPub = crypto.x25519_pubkey(linkXAPriv);
  const linkSigAPub = crypto.ed25519_pubkey(new Uint8Array(32).fill(0x22));

  const requestRaw = protocol.build_link_request(destHash, linkXAPub, linkSigAPub, 500);
  assert.equal(
    crypto.bytesToHex(requestRaw),
    '0200e2514be724c3807585d9d23a6479ad24007b4e909bbe7ffe44c465a220037d608ee35897d31ef972f07f74892cb0f73f13a09aa5f47a6759802ff955f8dc2d2a14a5c99d23be97f864127ff9383455a4f02001f4'
  );

  const unpacked = protocol.packet_unpack(requestRaw);
  const linkId = protocol.link_id_from_request(requestRaw, unpacked.data.length);
  assert.equal(crypto.bytesToHex(linkId), 'af7393771b9db23011a42d0559670f8f');
});

test('Link proof packet, derived_key, and RTT/keepalive/close tokens match RNS byte-for-byte', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const linkXAPriv = new Uint8Array(32).fill(0x11);
  const linkXAPub = crypto.x25519_pubkey(linkXAPriv);
  const linkXBPriv = new Uint8Array(32).fill(0x33);
  const linkXBPub = crypto.x25519_pubkey(linkXBPriv);
  const linkId = crypto.hexToBytes('af7393771b9db23011a42d0559670f8f');

  const proofRaw = protocol.build_link_proof(linkId, identity.private, linkXBPub, 500);
  assert.equal(
    crypto.bytesToHex(proofRaw),
    '0f00af7393771b9db23011a42d0559670f8fff8d1c3d0f95122d063800a0b088d18b3fa087c024903822c487599c49b869b7f870956aa836119105bd25921b1822278508e4db5e058c7855584d08924048de007b0d47d93427f8311160781c7c733fd89f88970aef490d8aa0ee19a4cb8a1b142001f4'
  );

  const derivedKeyA = protocol.link_handshake(linkXAPriv, linkXBPub, linkId);
  const derivedKeyB = protocol.link_handshake(linkXBPriv, linkXAPub, linkId);
  assert.equal(crypto.bytesToHex(derivedKeyA), crypto.bytesToHex(derivedKeyB));
  assert.equal(
    crypto.bytesToHex(derivedKeyA),
    'c91e17e3bb0024a834dd51ab4115a10c730c7187e834be686749c38079bb19cf26557046ebc2194aa519219ae595d700dcffd2da502b66e10504ef75482a3c7c'
  );

  const proofUnpacked = protocol.packet_unpack(proofRaw);
  const validated = protocol.validate_link_proof(proofUnpacked, linkId, crypto.ed25519_pubkey(identity.private.slice(32)));
  assert.ok(validated);
  assert.equal(crypto.bytesToHex(validated.peer_x_pub), crypto.bytesToHex(linkXBPub));
  assert.equal(validated.mtu, 500);

  // Decrypt real captured LRRTT/LINKCLOSE ciphertext with the derived key.
  const lrrttRaw = crypto.hexToBytes(
    '0c00af7393771b9db23011a42d0559670f8ffebae5098fa3d72e1234738c02525511113eea1f2a4e3e28c54e259808e2bdfffda9509d6478a8efb00ba7c0a3cd8e734d93643ce60317ff4f07216f0519417d98'
  );
  const lrrttUnpacked = protocol.packet_unpack(lrrttRaw);
  const rttPlaintext = protocol.link_decrypt(derivedKeyA, lrrttUnpacked.data);
  assert.equal(unpack(Buffer.from(rttPlaintext)), 2);

  const closeRaw = crypto.hexToBytes(
    '0c00af7393771b9db23011a42d0559670f8ffc4a05245122cce941f6df5ae1a4a9ded1a1d5205de7d1e26523f1645712601a593277f21c5f9c42848f41132e07c60043615fdf24dead860da712dcb61f59d9a2770140f583777a40e8ce73c54c8abb12'
  );
  const closeUnpacked = protocol.packet_unpack(closeRaw);
  const closePlaintext = protocol.link_decrypt(derivedKeyA, closeUnpacked.data);
  assert.equal(crypto.bytesToHex(closePlaintext), crypto.bytesToHex(linkId));

  // KEEPALIVE is sent unencrypted.
  const keepalive = protocol.build_link_packet(linkId, derivedKeyA, new Uint8Array([0xff]), protocol.CONTEXT_KEEPALIVE);
  assert.equal(crypto.bytesToHex(keepalive), '0c00af7393771b9db23011a42d0559670f8ffaff');
});

test('Link establishes, exchanges data both ways, and tears down between two independent Reticulum peers', async () => {
  const rnsA = new Reticulum(); // initiator's peer
  const rnsB = new Reticulum(); // responder's peer

  class Bridge extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
  }
  const ifaceA = new Bridge('A');
  const ifaceB = new Bridge('B');
  ifaceA.other = ifaceB;
  ifaceB.other = ifaceA;
  rnsA.addInterface(ifaceA);
  rnsB.addInterface(ifaceB);

  const responderIdentity = Identity.create();
  const responderDest = new Destination(rnsB, responderIdentity, Destination.IN, Destination.SINGLE, 'test', 'link');
  // In real use this would be constructed from just the peer's public
  // identity (learned via an announce); a full identity works fine here too
  // since Link only ever reads .identity.public on the initiator side.
  const outDest = new Destination(rnsA, responderIdentity, Destination.OUT, Destination.SINGLE, 'test', 'link');
  outDest.hash = responderDest.hash;

  const responderLinkPromise = new Promise((resolve) => responderDest.on('link', resolve));
  const initiatorLink = new Link(rnsA, outDest);

  await new Promise((resolve) => initiatorLink.once('established', resolve));
  assert.equal(initiatorLink.status, Link.ACTIVE);

  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  assert.equal(crypto.bytesToHex(initiatorLink.linkId), crypto.bytesToHex(responderLink.linkId));
  assert.equal(crypto.bytesToHex(initiatorLink.derivedKey), crypto.bytesToHex(responderLink.derivedKey));

  const responderGot = new Promise((resolve) => responderLink.once('packet', (d) => resolve(new TextDecoder().decode(d))));
  initiatorLink.send(new TextEncoder().encode('hello responder'));
  assert.equal(await responderGot, 'hello responder');

  const initiatorGot = new Promise((resolve) => initiatorLink.once('packet', (d) => resolve(new TextDecoder().decode(d))));
  responderLink.send(new TextEncoder().encode('hello initiator'));
  assert.equal(await initiatorGot, 'hello initiator');

  const responderClosed = new Promise((resolve) => responderLink.once('closed', resolve));
  initiatorLink.close();
  await responderClosed;

  assert.equal(initiatorLink.status, Link.CLOSED);
  assert.equal(responderLink.status, Link.CLOSED);
  assert.equal(rnsA.links.size, 0);
  assert.equal(rnsB.links.size, 0);
});

test('HDLC framing matches RNS.Interfaces.TCPInterface.HDLC for a payload containing flag/escape bytes', () => {
  const payload = Buffer.from([0x01, 0x7e, 0x02, 0x7d, 0x03, 0x7e, 0x7d, 0x00, 0xff]);
  const framed = hdlcFrame(payload);
  assert.equal(framed.toString('hex'), '7e017d5e027d5d037d5e7d5d00ff7e');
});

test('HDLC decoder recovers frames split across chunk boundaries and sent back-to-back', () => {
  const decoder = new HdlcFrameDecoder();
  const combined = Buffer.concat([hdlcFrame(Buffer.from('hello')), hdlcFrame(Buffer.from('world'))]);

  const frames = [
    ...decoder.push(combined.subarray(0, 7)),
    ...decoder.push(combined.subarray(7)),
  ];

  assert.deepEqual(frames.map((f) => Buffer.from(f).toString()), ['hello', 'world']);
});
