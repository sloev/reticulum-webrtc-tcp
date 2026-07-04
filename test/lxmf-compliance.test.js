// Verifies shared/rns/msgpack.js and the LXMF envelope in shared/rns/protocol.js
// (lxmf_build/lxmf_parse) against ground-truth byte vectors generated with the
// real reference implementation (PyPI `lxmf` 1.0.1, on top of `rns` 1.3.7), for
// two fixed test identities (private keys = bytes 0x00..0x3f and 0x40..0x7f).
// Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, Destination, Reticulum, Interface } from '../shared/rns/index.js';
import * as protocol from '../shared/rns/protocol.js';
import * as crypto from '../shared/rns/crypto.js';
import * as msgpack from '../shared/rns/msgpack.js';

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
