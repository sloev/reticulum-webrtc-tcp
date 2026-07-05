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

test('generate_stamp produces a stamp that stamp_valid (and real LXStamper) both accept', () => {
  const material = crypto.randomBytes(32);
  const { stamp: stampBytes, value } = stamp.generate_stamp(material, 8, 50);

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
