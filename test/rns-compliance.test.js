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

test('Link.identify() reveals the initiator\'s real identity to the responder, matching RNS.Link.identify()/get_remote_identity()', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();
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
  const responderDest = new Destination(rnsB, responderIdentity, Destination.IN, Destination.SINGLE, 'test', 'identify');
  const outDest = new Destination(rnsA, responderIdentity, Destination.OUT, Destination.SINGLE, 'test', 'identify');
  outDest.hash = responderDest.hash;

  const responderLinkPromise = new Promise((resolve) => responderDest.on('link', resolve));
  const initiatorLink = new Link(rnsA, outDest);
  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  assert.equal(responderLink.getRemoteIdentity(), null);

  const initiatorIdentity = Identity.create();
  const remoteIdentified = new Promise((resolve) => responderLink.once('remote-identified', resolve));
  initiatorLink.identify(initiatorIdentity);
  const revealed = await remoteIdentified;

  assert.equal(crypto.bytesToHex(revealed.public), crypto.bytesToHex(initiatorIdentity.public));
  assert.equal(crypto.bytesToHex(revealed.hash), crypto.bytesToHex(initiatorIdentity.hash));
  assert.equal(crypto.bytesToHex(responderLink.getRemoteIdentity().hash), crypto.bytesToHex(initiatorIdentity.hash));

  // The responder never calls identify() (matches real RNS: only the
  // initiator can prove identity this way), so the initiator's own link
  // never learns a "remote identity" for the other side.
  assert.equal(initiatorLink.getRemoteIdentity(), null);

  initiatorLink.close();
});

// --- RNS.Link Request/Response: ground truth captured from a real link
// (same fixed ephemeral keys as above, destination app "test.reqresp") ---

test('request_path_hash, request_id, and request/response payloads match RNS byte-for-byte', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const destHash = protocol.get_identity_destination_hash(identity.public, 'test.reqresp');

  const linkXAPriv = new Uint8Array(32).fill(0x11);
  const linkXAPub = crypto.x25519_pubkey(linkXAPriv);
  const linkSigAPub = crypto.ed25519_pubkey(new Uint8Array(32).fill(0x22));
  const linkXBPriv = new Uint8Array(32).fill(0x33);
  const linkXBPub = crypto.x25519_pubkey(linkXBPriv);

  const requestRaw = protocol.build_link_request(destHash, linkXAPub, linkSigAPub, 500);
  const unpacked = protocol.packet_unpack(requestRaw);
  const linkId = protocol.link_id_from_request(requestRaw, unpacked.data.length);
  assert.equal(crypto.bytesToHex(linkId), 'd7228df8a9a21d3b087a880fd5a171a1');

  const derivedKey = protocol.link_handshake(linkXAPriv, linkXBPub, linkId);
  assert.equal(crypto.bytesToHex(derivedKey), crypto.bytesToHex(protocol.link_handshake(linkXBPriv, linkXAPub, linkId)));

  assert.equal(crypto.bytesToHex(protocol.request_path_hash('test/path')), 'b04c3b75c4731c02f72d2ea9afcd7b66');

  const capturedRequestRaw = crypto.hexToBytes(
    '0c00d7228df8a9a21d3b087a880fd5a171a109ec15b94a5786c454871e5ab3961290a1d470e8ac21aeaada245bcfb879f0607ec33413b11a75cfbfbe49b6d801cc1421c921618c415026ab10fca9bb29be1f814c63228c9c73e924875bcc798c98fcb52b6338423ce0567a238d9b3a6ee30f12'
  );
  const requestId = protocol.packet_truncated_hash(capturedRequestRaw);
  assert.equal(crypto.bytesToHex(requestId), 'e51d8c03381cf737f8de45f58f8340f1');

  const capturedRequestUnpacked = protocol.packet_unpack(capturedRequestRaw);
  const requestPlaintext = protocol.link_decrypt(derivedKey, capturedRequestUnpacked.data);
  const { path_hash, data } = protocol.parse_request_payload(requestPlaintext);
  assert.equal(crypto.bytesToHex(path_hash), 'b04c3b75c4731c02f72d2ea9afcd7b66');
  assert.deepEqual(data, ['hello']);

  const capturedResponseRaw = crypto.hexToBytes(
    '0c00d7228df8a9a21d3b087a880fd5a171a10a82309b70c057e60740f49e137f8b09f9d3ab68d900880d0d966437e35caee763b1069bf1eac657e1f9df89e584aed5655acf70d1fc96a34262d552bc36fb153becd6a19769e1b907299bdef990369946'
  );
  const capturedResponseUnpacked = protocol.packet_unpack(capturedResponseRaw);
  const responsePlaintext = protocol.link_decrypt(derivedKey, capturedResponseUnpacked.data);
  const { request_id, response_data } = protocol.parse_response_payload(responsePlaintext);
  assert.equal(crypto.bytesToHex(request_id), crypto.bytesToHex(requestId));
  assert.deepEqual(response_data, ['world', 42]);
});

test('Link.request()/registerRequestHandler() round-trip a request and response over an established link', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();
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
  const responderDest = new Destination(rnsB, responderIdentity, Destination.IN, Destination.SINGLE, 'test', 'reqresp');
  responderDest.registerRequestHandler('greet', (data) => ({ reply: `hello ${data.name}` }));

  const outDest = new Destination(rnsA, responderIdentity, Destination.OUT, Destination.SINGLE, 'test', 'reqresp');
  outDest.hash = responderDest.hash;

  const initiatorLink = new Link(rnsA, outDest);
  await new Promise((resolve) => initiatorLink.once('established', resolve));

  const response = await initiatorLink.request('greet', { name: 'world' });
  assert.deepEqual(response, { reply: 'hello world' });

  await assert.rejects(initiatorLink.request('unknown/path', {}, { timeout: 200 }));

  // Otherwise the initiator's keepalive interval keeps running forever.
  initiatorLink.close();
});

test('Link.sendResource() transfers a multi-part payload and resolves once the receiver proves it, with content and hash verified on both ends', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

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

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'resource');

  const responderLinkPromise = new Promise((resolve) => destB.on('link', resolve));
  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'resource');
  outDest.hash = destB.hash;
  const initiatorLink = new Link(rnsA, outDest);

  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  // Comfortably larger than a single packet/link MDU (~400-odd bytes), so
  // this must actually split across multiple RESOURCE part packets.
  const payload = new TextEncoder().encode('resource payload: '.repeat(200));
  assert.ok(payload.length > 3000);

  const responderGot = new Promise((resolve) => responderLink.once('resource', resolve));
  const sendPromise = initiatorLink.sendResource(payload);

  const received = await responderGot;
  assert.equal(crypto.bytesToHex(received), crypto.bytesToHex(payload));

  await sendPromise; // resolves once the receiver's completion proof arrives back

  initiatorLink.close();
});

test('Link.sendResource() splits a payload bigger than one segment into multiple segments, reassembled correctly on the receiver', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

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

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'resource-segments');

  const responderLinkPromise = new Promise((resolve) => destB.on('link', resolve));
  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'resource-segments');
  outDest.hash = destB.hash;
  const initiatorLink = new Link(rnsA, outDest);

  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  // Bigger than two full segments, forcing at least 3 segments — built from
  // several smaller randomBytes() calls, since crypto.getRandomValues()
  // (which crypto.randomBytes() wraps) rejects requests over 64KiB.
  const payload = crypto.concat(crypto.randomBytes(60000), crypto.randomBytes(60000), crypto.randomBytes(1000));
  assert.ok(payload.length > protocol.RESOURCE_SEGMENT_MAX_SIZE * 2);

  const responderGot = new Promise((resolve) => responderLink.once('resource', resolve));
  const sendPromise = initiatorLink.sendResource(payload);

  const received = await responderGot;
  assert.equal(crypto.bytesToHex(received), crypto.bytesToHex(payload));

  await sendPromise;

  initiatorLink.close();
});

test('resource_prepare() throws if a single segment alone would still need more than RESOURCE_MAX_PARTS parts', () => {
  // Link.sendResource() always chops at RESOURCE_SEGMENT_MAX_SIZE, which is
  // sized so no chunk it produces can ever hit this — so this guard is only
  // reachable by calling resource_prepare() directly with an oversized chunk.
  const tooBig = new Uint8Array(protocol.RESOURCE_MAX_PARTS * protocol.RESOURCE_SDU + 1000);
  assert.throws(() => protocol.resource_prepare(tooBig, (pt) => pt));
});

// --- RNS.Transport: path requests/responses ---

test('path request destination hash and packet match RNS byte-for-byte', () => {
  assert.equal(crypto.bytesToHex(protocol.PATH_REQUEST_DEST_HASH), '6b9f66014d9853faab220fba47d02761');

  const destHash = new Uint8Array(16).fill(0xab);
  const transportId = new Uint8Array(16).fill(0xcd);
  const tag = new Uint8Array(16).fill(0xef);

  // The 3-field form (destination_hash + transport_id + tag) that a
  // transport-enabled real Reticulum node would send.
  const packet = protocol.packet_pack({
    header_type: 0, context_flag: 0, transport_type: protocol.TRANSPORT_BROADCAST, destination_type: protocol.DEST_PLAIN,
    packet_type: protocol.PACKET_DATA, hops: 0, destination_hash: protocol.PATH_REQUEST_DEST_HASH, context: protocol.CONTEXT_NONE,
    data: crypto.concat(destHash, transportId, tag),
  });
  assert.equal(
    crypto.bytesToHex(packet),
    '08006b9f66014d9853faab220fba47d0276100ababababababababababababababababcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdefefefefefefefefefefefefefefefef'
  );

  const parsed = protocol.parse_path_request(protocol.packet_unpack(packet));
  assert.equal(crypto.bytesToHex(parsed.destination_hash), crypto.bytesToHex(destHash));
  assert.equal(crypto.bytesToHex(parsed.requesting_transport_id), crypto.bytesToHex(transportId));
  assert.equal(crypto.bytesToHex(parsed.tag), crypto.bytesToHex(tag));

  // build_path_request() uses the simpler 2-field form (no transport ID).
  const simplePacket = protocol.build_path_request(destHash, tag);
  const simpleParsed = protocol.parse_path_request(protocol.packet_unpack(simplePacket));
  assert.equal(crypto.bytesToHex(simpleParsed.destination_hash), crypto.bytesToHex(destHash));
  assert.equal(simpleParsed.requesting_transport_id, null);
  assert.equal(crypto.bytesToHex(simpleParsed.tag), crypto.bytesToHex(tag));
});

test('path-response announce uses context=PATH_RESPONSE and matches RNS byte-for-byte', () => {
  const identity = new Identity(TEST_PRIVATE_KEY);
  const destHash = protocol.get_identity_destination_hash(identity.public, 'webrtc_demo.chat');
  const packet = protocol.build_announce(
    identity.private, identity.public, destHash, null, new Uint8Array(0), 'webrtc_demo.chat',
    new Uint8Array(0), protocol.CONTEXT_PATH_RESPONSE
  );
  assert.equal(packet[0], 0x01); // flags unchanged from a normal announce
  assert.equal(packet[18], 0x0b); // context byte = PATH_RESPONSE
});

test('a peer with no direct path to a destination discovers it via path request through a relay', async () => {
  // Topology: A <-> Relay <-> B. A and B never talk directly — this exercises
  // hop-count-correct announce propagation, the relay's path table, and
  // answering a path request with a cached (not locally-owned) announce.
  const rnsA = new Reticulum();
  const rnsRelay = new Reticulum();
  const rnsB = new Reticulum();

  class Bridge extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
  }
  const linkAR1 = new Bridge('A-side');
  const linkAR2 = new Bridge('Relay-side-A');
  linkAR1.other = linkAR2;
  linkAR2.other = linkAR1;
  rnsA.addInterface(linkAR1);
  rnsRelay.addInterface(linkAR2);

  const linkRB1 = new Bridge('Relay-side-B');
  const linkRB2 = new Bridge('B-side');
  linkRB1.other = linkRB2;
  linkRB2.other = linkRB1;
  rnsRelay.addInterface(linkRB1);
  rnsB.addInterface(linkRB2);

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'relay');

  // B announces; only the relay hears it directly (hops=1).
  const relayGotAnnounce = new Promise((resolve) => rnsRelay.once('announce', resolve));
  destB.announce();
  await relayGotAnnounce;
  assert.equal(rnsRelay.pathTable.get(crypto.bytesToHex(destB.hash)).hops, 1);
  assert.equal(rnsA.pathTable.has(crypto.bytesToHex(destB.hash)), false);

  // A requests a path to B's destination; the relay answers from its cache.
  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  rnsA.requestPath(destB.hash);
  await aGotAnnounce;

  assert.ok(rnsA.identities.has(crypto.bytesToHex(destB.hash)));
  const aPathEntry = rnsA.pathTable.get(crypto.bytesToHex(destB.hash));
  assert.ok(aPathEntry);
  assert.equal(aPathEntry.hops, 2); // one more hop than the relay's view
});

test('a single-destination message is delivered across two hops via next-hop forwarding, with no direct link between sender and recipient', async () => {
  // Same A <-> Relay <-> B topology, but this time actually sends an
  // encrypted message from A to B and confirms the relay forwards it via
  // Reticulum._forward() using the path table entry it learned from B's
  // announce — not just that a path can be discovered.
  const rnsA = new Reticulum();
  const rnsRelay = new Reticulum();
  const rnsB = new Reticulum();

  class Bridge extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
  }
  const linkAR1 = new Bridge('A-side');
  const linkAR2 = new Bridge('Relay-side-A');
  linkAR1.other = linkAR2;
  linkAR2.other = linkAR1;
  rnsA.addInterface(linkAR1);
  rnsRelay.addInterface(linkAR2);

  const linkRB1 = new Bridge('Relay-side-B');
  const linkRB2 = new Bridge('B-side');
  linkRB1.other = linkRB2;
  linkRB2.other = linkRB1;
  rnsRelay.addInterface(linkRB1);
  rnsB.addInterface(linkRB2);

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'multihop');

  const relayGotAnnounce = new Promise((resolve) => rnsRelay.once('announce', resolve));
  destB.announce();
  await relayGotAnnounce;

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  rnsA.requestPath(destB.hash);
  await aGotAnnounce;

  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'multihop');
  outDest.hash = destB.hash;

  const bGotPacket = new Promise((resolve) => destB.on('packet', (e) => resolve(new TextDecoder().decode(e.data))));
  outDest.send(new TextEncoder().encode('hello across two hops'));

  assert.equal(await bGotPacket, 'hello across two hops');
});

test('a Link establishes, exchanges data both ways, round-trips a Request/Response, and tears down through an intermediate relay with no direct link between initiator and responder', async () => {
  // Same A <-> Relay <-> B topology as the two tests above, but this time the
  // relay owns neither endpoint of a real Link — exercising
  // Reticulum._forwardLinkRequest()/_forwardLinkTraffic() (the "link table"),
  // which lets the LINKREQUEST, the responder's PROOF, ongoing application
  // data, a Request/Response round trip, and the eventual LINKCLOSE all pass
  // through the relay in either direction, keyed by link_id rather than the
  // path table (a link_id isn't a real, announced destination).
  const rnsA = new Reticulum();
  const rnsRelay = new Reticulum();
  const rnsB = new Reticulum();

  class Bridge extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
  }
  const linkAR1 = new Bridge('A-side');
  const linkAR2 = new Bridge('Relay-side-A');
  linkAR1.other = linkAR2;
  linkAR2.other = linkAR1;
  rnsA.addInterface(linkAR1);
  rnsRelay.addInterface(linkAR2);

  const linkRB1 = new Bridge('Relay-side-B');
  const linkRB2 = new Bridge('B-side');
  linkRB1.other = linkRB2;
  linkRB2.other = linkRB1;
  rnsRelay.addInterface(linkRB1);
  rnsB.addInterface(linkRB2);

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'linkrelay');
  destB.registerRequestHandler('greet', (data) => ({ reply: `hello ${data.name}` }));

  const relayGotAnnounce = new Promise((resolve) => rnsRelay.once('announce', resolve));
  destB.announce();
  await relayGotAnnounce;

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  rnsA.requestPath(destB.hash);
  await aGotAnnounce;

  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'linkrelay');
  outDest.hash = destB.hash;

  const responderLinkPromise = new Promise((resolve) => destB.on('link', resolve));
  const initiatorLink = new Link(rnsA, outDest);

  await new Promise((resolve) => initiatorLink.once('established', resolve));
  assert.equal(initiatorLink.status, Link.ACTIVE);

  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  assert.equal(crypto.bytesToHex(initiatorLink.linkId), crypto.bytesToHex(responderLink.linkId));
  assert.equal(crypto.bytesToHex(initiatorLink.derivedKey), crypto.bytesToHex(responderLink.derivedKey));
  assert.ok(rnsRelay.linkTable.has(crypto.bytesToHex(initiatorLink.linkId)), 'relay remembers this link_id in its link table');
  assert.equal(rnsRelay.links.has(crypto.bytesToHex(initiatorLink.linkId)), false, 'relay does not own the link itself');

  const responderGot = new Promise((resolve) => responderLink.once('packet', (d) => resolve(new TextDecoder().decode(d))));
  initiatorLink.send(new TextEncoder().encode('hello responder, through a relay'));
  assert.equal(await responderGot, 'hello responder, through a relay');

  const initiatorGot = new Promise((resolve) => initiatorLink.once('packet', (d) => resolve(new TextDecoder().decode(d))));
  responderLink.send(new TextEncoder().encode('hello initiator, through a relay'));
  assert.equal(await initiatorGot, 'hello initiator, through a relay');

  const response = await initiatorLink.request('greet', { name: 'relayed-world' });
  assert.deepEqual(response, { reply: 'hello relayed-world' });

  const responderClosed = new Promise((resolve) => responderLink.once('closed', resolve));
  initiatorLink.close();
  await responderClosed;

  assert.equal(rnsRelay.linkTable.has(crypto.bytesToHex(initiatorLink.linkId)), false, 'relay cleans up its link table entry once LINKCLOSE passes through');
});

test('packet delivery proof (implicit form) matches RNS.Packet.prove()/PacketReceipt.validate_proof() byte-for-byte', () => {
  const rawPacket = crypto.hexToBytes(
    '00002faebc8928662560965b80058e75991a0032304d474ae3fcf3fbfbe69adbc08e463eed019c823856dbaca7a34af69f8772f34a75cfeeda151f1f2f9c3b87b74cd11014d7abca02bc5a1aacde57fd859a94f9b92d29662e987fb5e894934e373894f9debfda1ffe805a9fdbb2eb5d818c4ed3a10fcef0375fb5509a80f99dc693af'
  );
  const fullHash = protocol.packet_full_hash(rawPacket);
  assert.equal(crypto.bytesToHex(fullHash), '4eb08be93adb3b6688d7f0097127da3e7a35cad5065526713c2e65d26422a5e2');

  const proofPacket = protocol.build_packet_proof(fullHash, TEST_PRIVATE_KEY);
  const parsed = protocol.packet_unpack(proofPacket);
  assert.equal(
    crypto.bytesToHex(parsed.data),
    '877456df4296cc353ccf1744db619fe59c2fa97662b4dba595cab5a1f798dae3acb9f595911db76460e4576b811850de428f3fa0e3ae5ad8dfcae894e63e5809'
  );

  const destPub = crypto.public_identity(TEST_PRIVATE_KEY);
  assert.equal(protocol.validate_packet_proof(parsed, fullHash, destPub), true);
});

test('Destination.send({ requestProof: true }) resolves once the receiver calls prove() on the received packet', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

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

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'proof');

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  destB.announce();
  await aGotAnnounce;

  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'proof');

  destB.on('packet', (e) => e.prove());
  const receipt = await outDest.send(new TextEncoder().encode('please confirm delivery'), { requestProof: true });
  assert.ok(receipt.packetFullHash);
});

test('Destination.send({ requestProof: true }) rejects on timeout if the receiver never proves the packet', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();

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

  const identityB = Identity.create();
  const destB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'test', 'proof-timeout');

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  destB.announce();
  await aGotAnnounce;

  const outDest = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'test', 'proof-timeout');

  // destB deliberately never calls e.prove() here.
  await assert.rejects(outDest.send(new TextEncoder().encode('nobody will confirm this'), { requestProof: true, timeout: 50 }));
});

test('an announce floods between two peers on the same multi-peer interface (e.g. a single WebRTCInterface relaying between two of its own data channels)', async () => {
  // Regression test for a bug where Reticulum.onPacketReceived's flood
  // rebroadcast only excluded the whole receiving Interface object, not the
  // specific neighbor a packet arrived from. That's invisible with the
  // Bridge helper above (one Interface object per link), but breaks any real
  // interface that aggregates multiple neighbors on one object — like
  // WebRTCInterface with several data channels, or TCPServerInterface with
  // several client sockets. Here a single interface object plays both of the
  // relay's neighbor connections, so a correct fix must call
  // sendDataExcluding(fromPeerId, ...) to relay from one peer to the other
  // while still not echoing the packet back to whichever peer sent it.
  const rnsA = new Reticulum();
  const rnsRelay = new Reticulum();
  const rnsC = new Reticulum();

  class MultiPeerBridge extends Interface {
    connect() {}
    // peers: Map of peerId -> the leaf's own Interface object, so the relay
    // can inject data straight into that leaf's Reticulum instance.
    sendData(data) {
      for (const leafIface of this.peers.values()) {
        setTimeout(() => leafIface.rns.onPacketReceived(data, leafIface), 0);
      }
    }
    sendDataExcluding(excludedPeerId, data) {
      for (const [peerId, leafIface] of this.peers.entries()) {
        if (peerId !== excludedPeerId) {
          setTimeout(() => leafIface.rns.onPacketReceived(data, leafIface), 0);
        }
      }
    }
  }

  // The relay has ONE interface object with two "peers": A and C.
  const relayIface = new MultiPeerBridge('relay-multi');
  relayIface.peers = new Map();
  rnsRelay.addInterface(relayIface);

  class LeafBridge extends Interface {
    connect() {}
    // A leaf sending data injects it straight into the relay's Reticulum
    // instance, tagged with which peer (this leaf) it arrived from.
    sendData(data) { setTimeout(() => rnsRelay.onPacketReceived(data, relayIface, this.peerId), 0); }
  }
  const ifaceA = new LeafBridge('A-side');
  const ifaceC = new LeafBridge('C-side');
  ifaceA.peerId = 'A';
  ifaceC.peerId = 'C';
  rnsA.addInterface(ifaceA);
  rnsC.addInterface(ifaceC);

  relayIface.peers.set('A', ifaceA);
  relayIface.peers.set('C', ifaceC);

  const identityA = Identity.create();
  const destA = new Destination(rnsA, identityA, Destination.IN, Destination.SINGLE, 'test', 'multipeer');

  const relayGotAnnounce = new Promise((resolve) => rnsRelay.once('announce', resolve));
  const cGotAnnounce = new Promise((resolve) => rnsC.once('announce', resolve));
  destA.announce();

  await relayGotAnnounce;
  const announceOnC = await cGotAnnounce;
  assert.equal(crypto.bytesToHex(announceOnC.destination_hash), crypto.bytesToHex(destA.hash));
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
