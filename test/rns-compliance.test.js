// Verifies shared/rns/* against ground-truth byte vectors generated with the
// real reference implementation (PyPI `rns` 1.3.7), for a fixed test identity
// (private key = bytes 0x00..0x3f). See shared/rns/protocol.js for how each
// value is derived. Run with: node --test
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, Destination, Reticulum, Interface } from '../shared/rns/index.js';
import * as protocol from '../shared/rns/protocol.js';
import * as crypto from '../shared/rns/crypto.js';
import { hdlcFrame, HdlcFrameDecoder } from '../node/hdlc.js';

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
