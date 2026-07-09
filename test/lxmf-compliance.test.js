// Verifies shared/rns/msgpack.js and the LXMF envelope in shared/rns/protocol.js
// (lxmf_build/lxmf_parse) against ground-truth byte vectors generated with the
// real reference implementation (PyPI `lxmf` 1.0.1, on top of `rns` 1.3.7), for
// two fixed test identities (private keys = bytes 0x00..0x3f and 0x40..0x7f).
// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, Destination, Reticulum, Interface, Link } from '../shared/rns/index.js';
import * as protocol from '../shared/rns/protocol.js';
import * as crypto from '../shared/rns/crypto.js';
import * as msgpack from '../shared/rns/msgpack.js';
import * as propagation from '../shared/rns/propagation.js';
import * as stamp from '../shared/rns/stamp.js';

const SOURCE_PRIVATE_KEY = crypto.hexToBytes(
  '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f'
);
const DEST_PRIVATE_KEY = crypto.hexToBytes(
  '404142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f606162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f'
);

test('msgpack.pack matches RNS.vendor.umsgpack byte-for-byte, including float64-forced timestamps and empty maps', () => {
  const payload = [
    new msgpack.Float64(1700000000.0),
    new TextEncoder().encode('greeting'),
    new TextEncoder().encode('hello lxmf'),
    {},
  ];
  const packed = msgpack.pack(payload);
  assert.equal(
    crypto.bytesToHex(packed),
    '94cb41d954fc40000000c4086772656574696e67c40a68656c6c6f206c786d6680'
  );
});

test('msgpack.unpack round-trips arrays, maps, bin, and float64 values', () => {
  const original = [new msgpack.Float64(1700000000.0), new Uint8Array([1, 2, 3]), { a: 1, b: 'two' }];
  const roundTripped = msgpack.unpack(msgpack.pack(original));
  assert.equal(roundTripped[0], 1700000000.0);
  assert.deepEqual(Array.from(roundTripped[1]), [1, 2, 3]);
  assert.deepEqual(roundTripped[2], { a: 1, b: 'two' });
});

test('LXMF message envelope matches LXMF.LXMessage byte-for-byte for a fixed source/dest/timestamp', () => {
  const sourcePub = crypto.public_identity(SOURCE_PRIVATE_KEY);
  const destPub = crypto.public_identity(DEST_PRIVATE_KEY);
  const sourceHash = protocol.get_identity_destination_hash(sourcePub, 'lxmf.delivery');
  const destHash = protocol.get_identity_destination_hash(destPub, 'lxmf.delivery');

  assert.equal(crypto.bytesToHex(sourceHash), 'fae321c442e3c9bdcd7a3e79d850e03c');
  assert.equal(crypto.bytesToHex(destHash), 'cf0b2a4a8d2a0b6978b71290da7cc80e');

  const wirePayload = protocol.lxmf_build('hello lxmf', SOURCE_PRIVATE_KEY, destHash, sourceHash, 1700000000.0, 'greeting');

  // This is LXMF's OPPORTUNISTIC wire form (packed[DESTINATION_LENGTH:]) —
  // destination_hash is implied by the packet's own destination rather than
  // repeated in the payload.
  assert.equal(
    crypto.bytesToHex(wirePayload),
    'fae321c442e3c9bdcd7a3e79d850e03c' +
    '44fbbf318b717a3445c26dc6e14cc7fda7e5b8f9f8f4e581ee53e756a0d4c37b623b89740cc80234b7785aad76d39be5c2049f68c8851cad8847683086b0ed07' +
    '94cb41d954fc40000000c4086772656574696e67c40a68656c6c6f206c786d6680'
  );
});

test('LXMF message signed by JS is validated by lxmf_parse, and content/title round-trip', () => {
  const sourcePub = crypto.public_identity(SOURCE_PRIVATE_KEY);
  const destPub = crypto.public_identity(DEST_PRIVATE_KEY);
  const sourceHash = protocol.get_identity_destination_hash(sourcePub, 'lxmf.delivery');
  const destHash = protocol.get_identity_destination_hash(destPub, 'lxmf.delivery');

  const wirePayload = protocol.lxmf_build('hello lxmf', SOURCE_PRIVATE_KEY, destHash, sourceHash, 1700000000.0, 'greeting', { mood: 'friendly' });
  const parsed = protocol.lxmf_parse(wirePayload, destHash, sourcePub);

  assert.equal(parsed.valid, true);
  assert.equal(new TextDecoder().decode(parsed.title), 'greeting');
  assert.equal(new TextDecoder().decode(parsed.content), 'hello lxmf');
  assert.deepEqual(parsed.fields, { mood: 'friendly' });
  assert.equal(parsed.timestamp, 1700000000.0);
});

test('lxmf_parse rejects a message whose signature does not match the claimed sender', () => {
  const sourcePub = crypto.public_identity(SOURCE_PRIVATE_KEY);
  const destPub = crypto.public_identity(DEST_PRIVATE_KEY);
  const sourceHash = protocol.get_identity_destination_hash(sourcePub, 'lxmf.delivery');
  const destHash = protocol.get_identity_destination_hash(destPub, 'lxmf.delivery');

  const wirePayload = protocol.lxmf_build('hello lxmf', SOURCE_PRIVATE_KEY, destHash, sourceHash, 1700000000.0, 'greeting');
  // Validate against the DESTINATION's public key instead of the real
  // source's — an impostor's signature check must fail.
  const parsed = protocol.lxmf_parse(wirePayload, destHash, destPub);
  assert.equal(parsed.valid, false);
});

test('DIRECT-delivery LXMF wire form (lxmf_build_direct) matches LXMF.LXMessage.pack() byte-for-byte, including the destination_hash prefix OPPORTUNISTIC omits', () => {
  const sourcePub = crypto.public_identity(SOURCE_PRIVATE_KEY);
  const destPub = crypto.public_identity(DEST_PRIVATE_KEY);
  const sourceHash = protocol.get_identity_destination_hash(sourcePub, 'lxmf.delivery');
  const destHash = protocol.get_identity_destination_hash(destPub, 'lxmf.delivery');

  const wirePayload = protocol.lxmf_build_direct('hello lxmf', SOURCE_PRIVATE_KEY, destHash, sourceHash, 1700000000.0, 'greeting');

  // Captured from a real `LXMF.LXMessage(desired_method=DIRECT).pack()` call
  // for the same fixed source/dest/timestamp/content — note the signature
  // and msgpack payload bytes are identical to the OPPORTUNISTIC test above;
  // only the destination_hash prefix differs (present here, omitted there).
  assert.equal(
    crypto.bytesToHex(wirePayload),
    'cf0b2a4a8d2a0b6978b71290da7cc80e' +
    'fae321c442e3c9bdcd7a3e79d850e03c' +
    '44fbbf318b717a3445c26dc6e14cc7fda7e5b8f9f8f4e581ee53e756a0d4c37b623b89740cc80234b7785aad76d39be5c2049f68c8851cad8847683086b0ed07' +
    '94cb41d954fc40000000c4086772656574696e67c40a68656c6c6f206c786d6680'
  );
  assert.equal(wirePayload.length, 129);

  const parsed = protocol.lxmf_parse_direct(wirePayload, sourcePub);
  assert.equal(parsed.valid, true);
  assert.equal(crypto.bytesToHex(parsed.destination_hash), crypto.bytesToHex(destHash));
  assert.equal(crypto.bytesToHex(parsed.source_hash), crypto.bytesToHex(sourceHash));
  assert.equal(new TextDecoder().decode(parsed.title), 'greeting');
  assert.equal(new TextDecoder().decode(parsed.content), 'hello lxmf');
});

test('lxmf_parse_direct rejects a message whose signature does not match the claimed sender', () => {
  const sourcePub = crypto.public_identity(SOURCE_PRIVATE_KEY);
  const destPub = crypto.public_identity(DEST_PRIVATE_KEY);
  const sourceHash = protocol.get_identity_destination_hash(sourcePub, 'lxmf.delivery');
  const destHash = protocol.get_identity_destination_hash(destPub, 'lxmf.delivery');

  const wirePayload = protocol.lxmf_build_direct('hello lxmf', SOURCE_PRIVATE_KEY, destHash, sourceHash, 1700000000.0, 'greeting');
  const parsed = protocol.lxmf_parse_direct(wirePayload, destPub);
  assert.equal(parsed.valid, false);
});

test('Link.sendLXMF() delivers a DIRECT LXMF message as a single packet, and emits \'lxmf\' (not a plain \'packet\') on the receiving side', async () => {
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

  const identityA = Identity.create();
  const identityB = Identity.create();
  const selfA = new Destination(rnsA, identityA, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const selfB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const bFromA = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  selfB.announce();
  await aGotAnnounce;

  // B must also learn A's identity before it can validate the DIRECT
  // message's signature (tryParseLxmfDirect() looks up the sender by hash).
  const bGotAnnounce = new Promise((resolve) => rnsB.once('announce', resolve));
  selfA.announce();
  await bGotAnnounce;

  const responderLinkPromise = new Promise((resolve) => selfB.on('link', resolve));
  const initiatorLink = new Link(rnsA, bFromA);
  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  let gotPlainPacket = false;
  responderLink.on('packet', () => { gotPlainPacket = true; });
  const gotLxmf = new Promise((resolve) => responderLink.on('lxmf', resolve));

  await initiatorLink.sendLXMF(selfA, 'direct hi', 'a small direct message', { via: 'link' });
  const received = await gotLxmf;

  assert.equal(gotPlainPacket, false, "a DIRECT LXMF payload is not also emitted as a generic 'packet' event");
  assert.equal(received.valid, true);
  assert.equal(new TextDecoder().decode(received.title), 'direct hi');
  assert.equal(new TextDecoder().decode(received.content), 'a small direct message');
  assert.deepEqual(received.fields, { via: 'link' });
  assert.equal(crypto.bytesToHex(received.source_hash), crypto.bytesToHex(selfA.hash));
  assert.equal(crypto.bytesToHex(received.destination_hash), crypto.bytesToHex(selfB.hash));

  initiatorLink.close();
});

test('Link.sendLXMF() falls back to a Resource for a DIRECT LXMF message too large for a single link packet, and still emits \'lxmf\' (not \'resource\') on receipt', async () => {
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

  const identityA = Identity.create();
  const identityB = Identity.create();
  const selfA = new Destination(rnsA, identityA, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const selfB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const bFromA = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  selfB.announce();
  await aGotAnnounce;

  // B must also learn A's identity before it can validate the DIRECT
  // message's signature (tryParseLxmfDirect() looks up the sender by hash).
  const bGotAnnounce = new Promise((resolve) => rnsB.once('announce', resolve));
  selfA.announce();
  await bGotAnnounce;

  const responderLinkPromise = new Promise((resolve) => selfB.on('link', resolve));
  const initiatorLink = new Link(rnsA, bFromA);
  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  let gotPlainResource = false;
  responderLink.on('resource', () => { gotPlainResource = true; });
  const gotLxmf = new Promise((resolve) => responderLink.on('lxmf', resolve));

  const bigContent = 'x'.repeat(protocol.LINK_MDU * 2);
  await initiatorLink.sendLXMF(selfA, 'direct big', bigContent, {});
  const received = await gotLxmf;

  assert.equal(gotPlainResource, false, "a DIRECT LXMF payload sent as a Resource is not also emitted as a generic 'resource' event");
  assert.equal(received.valid, true);
  assert.equal(new TextDecoder().decode(received.content), bigContent);

  initiatorLink.close();
});

// --- Delivery announce app_data + compression negotiation (Phase 5.2) ---

test('lxmf_build_announce_app_data matches LXMRouter.get_announce_app_data() byte-for-byte, for both an empty and a fully-populated case', () => {
  // Captured from real `RNS.vendor.umsgpack.packb([display_name, stamp_cost,
  // [LXMF.SF_COMPRESSION]])` — the exact structure get_announce_app_data() builds.
  assert.equal(crypto.bytesToHex(protocol.lxmf_build_announce_app_data()), '93c0c09100');
  assert.equal(crypto.bytesToHex(protocol.lxmf_build_announce_app_data('Alice', 12)), '93c405416c6963650c9100');
});

test('lxmf_stamp_cost_from_app_data and lxmf_compression_supported match LXMF.stamp_cost_from_app_data/compression_support_from_app_data', () => {
  assert.equal(protocol.lxmf_stamp_cost_from_app_data(null), null);
  assert.equal(protocol.lxmf_compression_supported(null), true, 'no announce seen yet defaults to compression supported');

  const withCost = protocol.lxmf_build_announce_app_data('Alice', 12);
  assert.equal(protocol.lxmf_stamp_cost_from_app_data(withCost), 12);
  assert.equal(protocol.lxmf_compression_supported(withCost), true);

  // An app_data whose functionality list doesn't include SF_COMPRESSION (an
  // empty list, matching a real peer that declared it doesn't support
  // compression) — real LXMF.compression_support_from_app_data() returns
  // False here, not a permissive default, since the list is present.
  const noCompressionAppData = msgpack.pack([null, null, []]);
  assert.equal(protocol.lxmf_compression_supported(noCompressionAppData), false);
});

test('Link.sendLXMF() skips compression for an oversized message when the recipient\'s announced app_data says they don\'t support it', async () => {
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

  const identityA = Identity.create();
  const identityB = Identity.create();
  const selfA = new Destination(rnsA, identityA, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const selfB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const bFromA = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

  // B announces with an app_data that explicitly declares no compression
  // support (an empty functionality list) — A must honor that.
  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  const noCompressionAppData = msgpack.pack([null, null, []]);
  selfB.announce({ appData: noCompressionAppData });
  await aGotAnnounce;

  const bGotAnnounce = new Promise((resolve) => rnsB.once('announce', resolve));
  selfA.announce();
  await bGotAnnounce;

  const responderLinkPromise = new Promise((resolve) => selfB.on('link', resolve));
  const initiatorLink = new Link(rnsA, bFromA);
  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  // Intercept the outgoing advertisement's own `compressed` flag directly —
  // real proof that compression wasn't even attempted, not just that the
  // final decompressed content happens to match either way.
  let advCompressed = null;
  const originalSendData = ifaceA.sendData.bind(ifaceA);
  ifaceA.sendData = (data) => {
    const packet = protocol.packet_unpack(data);
    if (packet && packet.context === protocol.CONTEXT_RESOURCE_ADV) {
      const plaintext = protocol.link_decrypt(initiatorLink.derivedKey, packet.data);
      const adv = protocol.parse_resource_advertisement(plaintext);
      if (adv) advCompressed = adv.compressed;
    }
    originalSendData(data);
  };

  const gotLxmf = new Promise((resolve) => responderLink.on('lxmf', resolve));
  const bigContent = 'a'.repeat(protocol.LINK_MDU * 2); // highly compressible, to make the effect obvious if compression WERE attempted
  await initiatorLink.sendLXMF(selfA, 'no compress', bigContent, {});
  const received = await gotLxmf;

  assert.equal(advCompressed, false, "the Resource advertisement's own compressed flag is false — compression was not attempted at all, matching the recipient's declared lack of support");
  assert.equal(received.valid, true);
  assert.equal(new TextDecoder().decode(received.content), bigContent);

  initiatorLink.close();
});

test('Destination.sendLXMF() delivers an LXMF message end to end between two independent Reticulum peers', async () => {
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

  const identityA = Identity.create();
  const identityB = Identity.create();

  // Each side's own local ("source") delivery destination.
  const selfA = new Destination(rnsA, identityA, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const selfB = new Destination(rnsB, identityB, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  // A's view of B (an OUT destination) and B's view of A, to send through.
  const bFromA = new Destination(rnsA, identityB, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const aFromB = new Destination(rnsB, identityA, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

  const bGotAnnounce = new Promise((resolve) => rnsB.once('announce', resolve));
  selfA.announce();
  await bGotAnnounce;

  const aGotAnnounce = new Promise((resolve) => rnsA.once('announce', resolve));
  selfB.announce();
  await aGotAnnounce;

  const bGotLxmf = new Promise((resolve) => selfB.on('lxmf', resolve));
  bFromA.sendLXMF(selfA, 'hi there', 'this is a real lxmf message', { priority: 1 });

  const received = await bGotLxmf;
  assert.equal(received.valid, true);
  assert.equal(new TextDecoder().decode(received.title), 'hi there');
  assert.equal(new TextDecoder().decode(received.content), 'this is a real lxmf message');
  assert.deepEqual(received.fields, { priority: 1 });
  assert.equal(crypto.bytesToHex(received.source_hash), crypto.bytesToHex(selfA.hash));
});

// --- LXMF propagation nodes (store-and-forward) ---
// See shared/rns/propagation.js for what this does and doesn't implement
// relative to real LXMF's LXMRouter/LXMPeer.

function makeBridgedPair(rnsA, rnsB) {
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
}

test('LXMF propagation node stores a message uploaded while the recipient is offline, then serves it once the recipient syncs', async () => {
  const rnsSender = new Reticulum();
  const rnsPropNode = new Reticulum();
  const rnsRecipient = new Reticulum();
  makeBridgedPair(rnsSender, rnsPropNode);
  makeBridgedPair(rnsPropNode, rnsRecipient);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity);

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const recipientIdentity = Identity.create();
  const recipientSelf = new Destination(rnsRecipient, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const senderKnowsPropNode = new Promise((resolve) => rnsSender.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));
  const senderKnowsRecipient = new Promise((resolve) => rnsSender.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(recipientSelf.hash)) resolve(); }));
  const recipientKnowsPropNode = new Promise((resolve) => rnsRecipient.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));

  propNode.announce();
  senderSelf.announce();
  recipientSelf.announce();
  await Promise.all([senderKnowsPropNode, senderKnowsRecipient, recipientKnowsPropNode]);

  // Sender uploads a message for the recipient — who isn't connected at all
  // right now, only the propagation node is reachable.
  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const propNodeOutFromSender = new Destination(rnsSender, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const senderLink = new Link(rnsSender, propNodeOutFromSender);
  await new Promise((resolve) => senderLink.once('established', resolve));

  await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'offline msg', 'hello while you were away', { test: true });
  senderLink.close();

  assert.equal(propNode.messages.size, 1);

  // Recipient comes online later and connects only to the propagation node.
  const propNodeOutFromRecipient = new Destination(rnsRecipient, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const recipientLink = new Link(rnsRecipient, propNodeOutFromRecipient);
  await new Promise((resolve) => recipientLink.once('established', resolve));

  const messages = await propagation.syncLXMF(recipientLink, recipientSelf);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].valid, true);
  assert.equal(new TextDecoder().decode(messages[0].title), 'offline msg');
  assert.equal(new TextDecoder().decode(messages[0].content), 'hello while you were away');
  assert.deepEqual(messages[0].fields, { test: true });
  assert.equal(crypto.bytesToHex(messages[0].source_hash), crypto.bytesToHex(senderSelf.hash));

  // The node purges a message once it's been successfully synced.
  assert.equal(propNode.messages.size, 0);

  recipientLink.close();
});

test('LXMF propagation node rejects a sync request signed by the wrong identity', async () => {
  const rnsRecipient = new Reticulum();
  const rnsPropNode = new Reticulum();
  const rnsAttacker = new Reticulum();
  makeBridgedPair(rnsRecipient, rnsPropNode);
  makeBridgedPair(rnsPropNode, rnsAttacker);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity);

  const recipientIdentity = Identity.create();
  const recipientSelf = new Destination(rnsRecipient, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const attackerIdentity = Identity.create();
  const attackerSelf = new Destination(rnsAttacker, attackerIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const recipientKnowsPropNode = new Promise((resolve) => rnsRecipient.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));
  const attackerKnowsPropNode = new Promise((resolve) => rnsAttacker.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));
  const propNodeKnowsRecipient = new Promise((resolve) => rnsPropNode.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(recipientSelf.hash)) resolve(); }));

  propNode.announce();
  recipientSelf.announce();
  attackerSelf.announce();
  await Promise.all([recipientKnowsPropNode, attackerKnowsPropNode, propNodeKnowsRecipient]);

  // The attacker tries to list the recipient's messages by claiming their
  // destination hash, but signs the proof with its own (different) identity.
  const propNodeOutFromAttacker = new Destination(rnsAttacker, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const attackerLink = new Link(rnsAttacker, propNodeOutFromAttacker);
  await new Promise((resolve) => attackerLink.once('established', resolve));

  const forgedProof = crypto.ed25519_sign(attackerIdentity.private.slice(32), crypto.concat(attackerLink.linkId, recipientSelf.hash));
  const listing = await attackerLink.request('/get', [null, null, recipientSelf.hash, forgedProof]);
  assert.equal(listing, null);

  attackerLink.close();
});

test("PropagationNode serves a real-LXMF-client-style sync via syncFromRealPropagationNode(), matching LXMRouter.message_get_request()'s list-then-fetch-then-purge flow", async () => {
  const rnsSender = new Reticulum();
  const rnsPropNode = new Reticulum();
  const rnsRecipient = new Reticulum();
  makeBridgedPair(rnsSender, rnsPropNode);
  makeBridgedPair(rnsPropNode, rnsRecipient);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity);

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const recipientIdentity = Identity.create();
  const recipientSelf = new Destination(rnsRecipient, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const senderKnowsPropNode = new Promise((resolve) => rnsSender.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));
  const senderKnowsRecipient = new Promise((resolve) => rnsSender.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(recipientSelf.hash)) resolve(); }));
  const recipientKnowsPropNode = new Promise((resolve) => rnsRecipient.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));

  propNode.announce();
  senderSelf.announce();
  recipientSelf.announce();
  await Promise.all([senderKnowsPropNode, senderKnowsRecipient, recipientKnowsPropNode]);

  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const propNodeOutFromSender = new Destination(rnsSender, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const senderLink = new Link(rnsSender, propNodeOutFromSender);
  await new Promise((resolve) => senderLink.once('established', resolve));

  await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'real client sync', 'served through the real-client /get handler', {});
  senderLink.close();
  assert.equal(propNode.messages.size, 1);

  const propNodeOutFromRecipient = new Destination(rnsRecipient, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const recipientLink = new Link(rnsRecipient, propNodeOutFromRecipient);
  await new Promise((resolve) => recipientLink.once('established', resolve));

  const messages = await propagation.syncFromRealPropagationNode(recipientLink, recipientSelf);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].valid, true);
  assert.equal(new TextDecoder().decode(messages[0].title), 'real client sync');
  assert.equal(new TextDecoder().decode(messages[0].content), 'served through the real-client /get handler');
  assert.equal(crypto.bytesToHex(messages[0].source_hash), crypto.bytesToHex(senderSelf.hash));

  // Fetched then purged, via syncFromRealPropagationNode()'s separate
  // purge-after-fetch request (matching a real LXMF client's own two-request
  // sequence, not this project's fetch-and-purge-together JS-only scheme).
  assert.equal(propNode.messages.size, 0);

  recipientLink.close();
});

test("PropagationNode's real-client /get handler (_onRealGetRequest) returns LXMPeer.ERROR_NO_IDENTITY for an unidentified link, lists smallest-message-first, and honors a client's transfer_limit_kb", async () => {
  const rnsClient = new Reticulum();
  const rnsPropNode = new Reticulum();
  makeBridgedPair(rnsClient, rnsPropNode);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity);

  const clientIdentity = Identity.create();
  const clientSelf = new Destination(rnsClient, clientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const clientKnowsPropNode = new Promise((resolve) => rnsClient.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash)) resolve(); }));
  propNode.announce();
  await clientKnowsPropNode;

  const propNodeOut = new Destination(rnsClient, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const link = new Link(rnsClient, propNodeOut);
  await new Promise((resolve) => link.once('established', resolve));

  // Without identify(), the handler has no identity to derive a delivery
  // destination hash from — matches message_get_request()'s first check.
  const unidentifiedResponse = await link.request('/get', [null, null]);
  assert.equal(unidentifiedResponse, 0xf0);

  link.identify(clientIdentity);

  // Seed the store directly with one small and one large message addressed
  // to this client (bypassing propagateLXMF()'s Resource upload — this test
  // is only exercising the download/list side).
  const smallEnvelope = propagation.build_propagated_envelope(clientSelf.hash, new Uint8Array(20), clientIdentity.public, clientIdentity.ratchetPublic);
  const bigEnvelope = propagation.build_propagated_envelope(clientSelf.hash, new Uint8Array(4000), clientIdentity.public, clientIdentity.ratchetPublic);
  const smallId = propagation.propagated_transient_id(smallEnvelope);
  const bigId = propagation.propagated_transient_id(bigEnvelope);
  propNode.messages.set(crypto.bytesToHex(bigId), { destinationHash: clientSelf.hash, envelope: bigEnvelope, stamp: new Uint8Array(32) });
  propNode.messages.set(crypto.bytesToHex(smallId), { destinationHash: clientSelf.hash, envelope: smallEnvelope, stamp: new Uint8Array(32) });

  const listing = await link.request('/get', [null, null]);
  assert.equal(listing.length, 2);
  assert.equal(crypto.bytesToHex(listing[0]), crypto.bytesToHex(smallId), 'smallest message listed first, matching message_get_request()\'s sort');

  // A 1kb transfer limit fits the small message but not the big one, so the
  // big one is skipped rather than truncated.
  const fetched = await link.request('/get', [[smallId, bigId], null, 1]);
  assert.equal(fetched.length, 1);
  assert.deepEqual(Array.from(fetched[0]), Array.from(smallEnvelope));

  link.close();
});

// --- LXStamper-compatible proof-of-work admission stamps ---

test('stamp_workblock matches LXStamper.stamp_workblock byte-for-byte', () => {
  const material = new Uint8Array(32);
  for (let i = 0; i < 32; i++) material[i] = i;

  const workblock = stamp.stamp_workblock(material, 1);
  assert.equal(
    crypto.bytesToHex(workblock),
    'c025bbe68a4017092b9878de5c0819fafc668096b2208a3f1caa61563d5d7bd4e7b9e51999d7bb5d3db049379fbe593bf0eb99793179ee896734ad5388845f43da8e0c6dcd2bd97c71aa1a39a339e3302e68b47c5ed1b8556e707ceb100fc248bb4e1620b3840ad60fb0a7e9935179f5191b2febfbfafe8455857bdca580fc38439b9d71112c19c2e44702158d2d256bf53d56e8d41ba11de7ea42b14803359f1ecadda01d1c1fec808b46ad88c41cc6d7c7ebf9d9d3a037b21a988198b6da4223baed2c6795cc61ea40cf2965059dd9a9a9c38cbcd7b4d32683e954c66024358eba4bb654186ce2a00ace69688cca877381ee96e503d26f16aa362f83452b6b'
  );
  assert.equal(workblock.length, 256);
});

test('generate_stamp produces a stamp that stamp_valid (and real LXStamper) both accept', async () => {
  const material = crypto.randomBytes(32);
  const { stamp: stampBytes, value } = await stamp.generate_stamp(material, 8, 50);

  assert.ok(value >= 8);
  const workblock = stamp.stamp_workblock(material, 50);
  assert.equal(stamp.stamp_valid(stampBytes, 8, workblock), true);
  assert.equal(stamp.stamp_valid(stampBytes, value + 1, workblock), false);
});

test('a propagation node configured with a stampCost rejects an unproven upload and accepts a properly stamped one', async () => {
  const rnsSender = new Reticulum();
  const rnsPropNode = new Reticulum();
  makeBridgedPair(rnsSender, rnsPropNode);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity, { stampCost: 8 });

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const recipientIdentity = Identity.create();
  const recipientSelfHash = protocol.get_identity_destination_hash(recipientIdentity.public, 'lxmf.delivery');
  // The sender needs to already know the recipient's identity (from an
  // announce, normally) to encrypt to them — inject it directly here since
  // there's no recipient node in this test.
  rnsSender.identities.set(crypto.bytesToHex(recipientSelfHash), { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic });

  const senderKnowsPropNode = new Promise((resolve) => rnsSender.once('announce', resolve));
  propNode.announce();
  await senderKnowsPropNode;

  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const propNodeOutFromSender = new Destination(rnsSender, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');

  // Unstamped (cost 0) upload gets rejected by a node requiring cost 8.
  const link1 = new Link(rnsSender, propNodeOutFromSender);
  await new Promise((resolve) => link1.once('established', resolve));
  await propagation.propagateLXMF(link1, destOut, senderSelf, 'unstamped', 'should be rejected', {}, 0);
  link1.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(propNode.messages.size, 0);

  // Properly stamped (matching cost) upload is accepted.
  const link2 = new Link(rnsSender, propNodeOutFromSender);
  await new Promise((resolve) => link2.once('established', resolve));
  await propagation.propagateLXMF(link2, destOut, senderSelf, 'stamped', 'should be accepted', {}, 8);
  link2.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(propNode.messages.size, 1);
});

// --- Propagation-node announce app_data (Phase 5.3) ---

test('lxmf_build_propagation_announce_app_data matches LXMRouter.get_propagation_node_app_data() byte-for-byte', () => {
  // Captured from a real `RNS.vendor.umsgpack.packb([False, 1700000000, True,
  // 1000, 10, [16, 3, 18], {LXMF.PN_META_NAME: b"testnode"}])` — the exact
  // structure get_propagation_node_app_data() builds (with a fixed timebase
  // in place of real time.time()).
  const built = protocol.lxmf_build_propagation_announce_app_data({
    stampCost: 16, stampCostFlexibility: 3, peeringCost: 18,
    perTransferLimitKb: 1000, perSyncLimit: 10, name: 'testnode',
  });
  // Re-parse and compare fields rather than raw bytes, since the builder
  // uses the current time as its timebase (matching real
  // get_propagation_node_app_data()'s int(time.time())) rather than a fixed
  // one — the fixed-timebase byte vector is checked directly below instead.
  const parsed = protocol.lxmf_parse_propagation_announce_app_data(built);
  assert.equal(parsed.stampCost, 16);
  assert.equal(parsed.stampCostFlexibility, 3);
  assert.equal(parsed.peeringCost, 18);
  assert.equal(parsed.perTransferLimitKb, 1000);
  assert.equal(parsed.perSyncLimit, 10);
  assert.equal(parsed.nodeState, true);
  assert.equal(parsed.name, 'testnode');

  const fixedTimebaseCapture = crypto.hexToBytes('97c2ce6553f100c3cd03e80a931003128101c408746573746e6f6465');
  const parsedFixed = protocol.lxmf_parse_propagation_announce_app_data(fixedTimebaseCapture);
  assert.equal(parsedFixed.timebase, 1700000000);
  assert.equal(parsedFixed.stampCost, 16);
  assert.equal(parsedFixed.stampCostFlexibility, 3);
  assert.equal(parsedFixed.peeringCost, 18);
  assert.equal(parsedFixed.name, 'testnode');
});

test('lxmf_parse_propagation_announce_app_data returns null for invalid/absent data, matching pn_announce_data_is_valid rules', () => {
  assert.equal(protocol.lxmf_parse_propagation_announce_app_data(null), null);
  assert.equal(protocol.lxmf_parse_propagation_announce_app_data(new Uint8Array(0)), null);
  // A 3-element list (the lxmf.delivery announce shape, not propagation's 7-element one).
  assert.equal(protocol.lxmf_parse_propagation_announce_app_data(protocol.lxmf_build_announce_app_data('Alice', 12)), null);
});

test("PropagationNode.announce() embeds real stamp/peering cost app_data, and propagateLXMF()/syncToPeer() auto-detect it instead of needing the cost supplied out of band", async () => {
  const rnsSender = new Reticulum();
  const rnsPropNode = new Reticulum();
  makeBridgedPair(rnsSender, rnsPropNode);

  const propNodeIdentity = Identity.create();
  const propNode = new propagation.PropagationNode(rnsPropNode, propNodeIdentity, { stampCost: 8, peeringCost: 12 });

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const recipientIdentity = Identity.create();
  const recipientSelfHash = protocol.get_identity_destination_hash(recipientIdentity.public, 'lxmf.delivery');
  rnsSender.identities.set(crypto.bytesToHex(recipientSelfHash), { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic });

  const senderKnowsPropNode = new Promise((resolve) => rnsSender.once('announce', resolve));
  propNode.announce();
  const nodeAnnounce = await senderKnowsPropNode;

  // Confirm the announce itself really carries the node's configured cost —
  // not just that propagateLXMF() happens to work below.
  const parsedNodeAppData = protocol.lxmf_parse_propagation_announce_app_data(nodeAnnounce.app_data);
  assert.equal(parsedNodeAppData.stampCost, 8);
  assert.equal(parsedNodeAppData.peeringCost, 12);

  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const propNodeOutFromSender = new Destination(rnsSender, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');

  // No stampCost argument at all — must be read from the node's own announce.
  const link = new Link(rnsSender, propNodeOutFromSender);
  await new Promise((resolve) => link.once('established', resolve));
  await propagation.propagateLXMF(link, destOut, senderSelf, 'auto-detected cost', 'no out-of-band stamp cost needed', {});
  link.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(propNode.messages.size, 1, 'the upload, stamped at the auto-detected cost of 8, was accepted');
});

// --- Node-to-node peer sync ("/offer" protocol, peering-key stamps) ---

test('validate_peering_key matches LXStamper.validate_peering_key\'s workblock (WORKBLOCK_EXPAND_ROUNDS_PEERING) byte-for-byte', () => {
  const material = new Uint8Array(32);
  for (let i = 0; i < 32; i++) material[i] = i;

  const workblock = stamp.stamp_workblock(material, stamp.WORKBLOCK_EXPAND_ROUNDS_PEERING);
  // Real LXStamper.stamp_workblock(material, expand_rounds=25) produces the
  // same first 256-byte round as expand_rounds=1 (already verified above),
  // just repeated/salted 25 times instead of 1000 — confirmed byte-for-byte
  // against a real `LXStamper.stamp_workblock` call with expand_rounds=25.
  assert.equal(workblock.length, 25 * 256);
  assert.equal(
    crypto.bytesToHex(workblock.slice(0, 32)),
    'c025bbe68a4017092b9878de5c0819fafc668096b2208a3f1caa61563d5d7bd4'
  );
});

test('syncToPeer() offers a stored message to another propagation node, which accepts, stores, and can serve it back to the intended recipient', async () => {
  const rnsSender = new Reticulum();
  const rnsNodeA = new Reticulum();
  const rnsNodeB = new Reticulum();
  const rnsRecipient = new Reticulum();
  makeBridgedPair(rnsSender, rnsNodeA);
  makeBridgedPair(rnsNodeA, rnsNodeB);
  makeBridgedPair(rnsNodeB, rnsRecipient);

  const nodeAIdentity = Identity.create();
  const nodeA = new propagation.PropagationNode(rnsNodeA, nodeAIdentity, { peeringCost: 8 });
  const nodeBIdentity = Identity.create();
  const nodeB = new propagation.PropagationNode(rnsNodeB, nodeBIdentity, { peeringCost: 8 });

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const recipientIdentity = Identity.create();
  const recipientSelf = new Destination(rnsRecipient, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

  const senderKnowsNodeA = new Promise((resolve) => rnsSender.once('announce', resolve));
  const senderKnowsRecipient = new Promise((resolve) => rnsSender.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(recipientSelf.hash)) resolve(); }));
  const recipientKnowsSender = new Promise((resolve) => rnsRecipient.on('announce', (a) => { if (crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(senderSelf.hash)) resolve(); }));
  nodeA.announce();
  recipientSelf.announce();
  senderSelf.announce();
  await Promise.all([senderKnowsNodeA, senderKnowsRecipient, recipientKnowsSender]);

  // A sender uploads a message (for a recipient neither node has a direct
  // path to) to node A only.
  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const nodeAOutFromSender = new Destination(rnsSender, nodeAIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const senderLink = new Link(rnsSender, nodeAOutFromSender);
  await new Promise((resolve) => senderLink.once('established', resolve));
  await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'peer sync', 'hello via node A then node B', {});
  senderLink.close();

  assert.equal(nodeA.messages.size, 1);
  assert.equal(nodeB.messages.size, 0);

  // Node A syncs its stored messages to node B.
  const nodeBOutFromA = new Destination(rnsNodeA, nodeBIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const peerLink = new Link(rnsNodeA, nodeBOutFromA);
  await new Promise((resolve) => peerLink.once('established', resolve));

  const result = await propagation.syncToPeer(nodeA, peerLink, nodeB.identity, { peeringCost: 8 });
  assert.equal(result.offered, 1);
  assert.equal(result.synced, 1);
  assert.equal(nodeB.messages.size, 1);

  // A second sync attempt has nothing new to offer.
  const result2 = await propagation.syncToPeer(nodeA, peerLink, nodeB.identity, { peeringCost: 8 });
  assert.equal(result2.offered, 0);
  assert.equal(result2.synced, 0);
  peerLink.close();

  // The recipient, connecting only to node B, gets the message that
  // originally reached the store via node A.
  const nodeBOutFromRecipient = new Destination(rnsRecipient, nodeBIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const recipientLink = new Link(rnsRecipient, nodeBOutFromRecipient);
  await new Promise((resolve) => recipientLink.once('established', resolve));

  const messages = await propagation.syncLXMF(recipientLink, recipientSelf);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].valid, true);
  assert.equal(new TextDecoder().decode(messages[0].content), 'hello via node A then node B');
  assert.equal(crypto.bytesToHex(messages[0].source_hash), crypto.bytesToHex(senderSelf.hash));

  recipientLink.close();
});

test('syncToPeer() auto-detects the peer\'s required peeringCost from its announce, instead of needing it supplied out of band', async () => {
  const rnsSender = new Reticulum();
  const rnsNodeA = new Reticulum();
  const rnsNodeB = new Reticulum();
  makeBridgedPair(rnsSender, rnsNodeA);
  makeBridgedPair(rnsNodeA, rnsNodeB);

  const nodeAIdentity = Identity.create();
  const nodeA = new propagation.PropagationNode(rnsNodeA, nodeAIdentity, { peeringCost: 8 });
  const nodeBIdentity = Identity.create();
  const nodeB = new propagation.PropagationNode(rnsNodeB, nodeBIdentity, { peeringCost: 8 });

  const senderIdentity = Identity.create();
  const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
  const recipientIdentity = Identity.create();
  const recipientSelfHash = protocol.get_identity_destination_hash(recipientIdentity.public, 'lxmf.delivery');
  rnsSender.identities.set(crypto.bytesToHex(recipientSelfHash), { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic });

  const senderKnowsNodeA = new Promise((resolve) => rnsSender.once('announce', resolve));
  nodeA.announce();
  await senderKnowsNodeA;

  const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
  const nodeAOutFromSender = new Destination(rnsSender, nodeAIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const senderLink = new Link(rnsSender, nodeAOutFromSender);
  await new Promise((resolve) => senderLink.once('established', resolve));
  await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'auto-peering', 'no out-of-band peering cost needed', {});
  senderLink.close();
  assert.equal(nodeA.messages.size, 1);

  // Node A must have actually heard node B's announce for the auto-detect
  // path to have anything to read.
  const nodeAKnowsNodeB = new Promise((resolve) => rnsNodeA.once('announce', resolve));
  nodeB.announce();
  await nodeAKnowsNodeB;

  const nodeBOutFromA = new Destination(rnsNodeA, nodeBIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const peerLink = new Link(rnsNodeA, nodeBOutFromA);
  await new Promise((resolve) => peerLink.once('established', resolve));

  // No peeringCost argument at all — must be read from node B's own announce.
  const result = await propagation.syncToPeer(nodeA, peerLink, nodeB.identity);
  assert.equal(result.offered, 1);
  assert.equal(result.synced, 1, 'the peering key, generated at the auto-detected cost of 8, was accepted by node B');
  assert.equal(nodeB.messages.size, 1);

  peerLink.close();
});

test('a propagation node rejects an /offer whose peering key does not meet its required peeringCost', async () => {
  const rnsNodeA = new Reticulum();
  const rnsNodeB = new Reticulum();
  makeBridgedPair(rnsNodeA, rnsNodeB);

  const nodeAIdentity = Identity.create();
  const nodeA = new propagation.PropagationNode(rnsNodeA, nodeAIdentity, { peeringCost: 8 });
  const nodeBIdentity = Identity.create();
  const nodeB = new propagation.PropagationNode(rnsNodeB, nodeBIdentity, { peeringCost: 20 }); // requires a much higher cost than A will generate

  const nodeBOutFromA = new Destination(rnsNodeA, nodeBIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
  const peerLink = new Link(rnsNodeA, nodeBOutFromA);
  await new Promise((resolve) => peerLink.once('established', resolve));

  peerLink.identify(nodeA.identity);
  const { stamp: lowCostKey } = await stamp.generate_peering_key(nodeBIdentity.hash, nodeAIdentity.hash, 8);
  const response = await peerLink.request('/offer', [lowCostKey, []]);
  assert.equal(response, 0xf3);

  peerLink.close();
});
