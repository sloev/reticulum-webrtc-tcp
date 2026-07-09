// Verifies shared/rns/storage.js and the Reticulum/PropagationNode
// saveState()/loadState() methods that use it (compliance.md Phase 7 —
// persistence is an adaptation for surviving restarts, not a wire-format
// compliance concern, so these tests only check round-tripping with
// ourselves, not byte-for-byte matching against RNS's own on-disk formats).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NodeFileStorage } from '../shared/rns/storage.js';
import { Reticulum, Identity, Destination, Interface } from '../shared/rns/index.js';
import * as propagation from '../shared/rns/propagation.js';
import * as crypto from '../shared/rns/crypto.js';

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'rns-storage-test-'));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('NodeFileStorage round-trips arbitrary values, including Uint8Array fields, and returns null for a missing key', async () => {
  await withTempDir(async (dir) => {
    const storage = new NodeFileStorage(dir);
    const value = { hops: 3, packet: new Uint8Array([1, 2, 3, 4]), nested: { ok: true } };
    await storage.save('some_key', value);

    const loaded = await storage.load('some_key');
    assert.equal(loaded.hops, 3);
    assert.deepEqual(Array.from(loaded.packet), [1, 2, 3, 4]);
    assert.deepEqual(loaded.nested, { ok: true });

    assert.equal(await storage.load('missing_key'), null);
  });
});

test('NodeFileStorage.listKeys()/delete() manage a one-file-per-message directory', async () => {
  await withTempDir(async (dir) => {
    const storage = new NodeFileStorage(dir);
    assert.deepEqual(await storage.listKeys('propagation'), [], 'a not-yet-created subdirectory lists as empty, not an error');

    await storage.save('propagation/aaaa', { x: 1 });
    await storage.save('propagation/bbbb', { x: 2 });
    assert.deepEqual((await storage.listKeys('propagation')).sort(), ['aaaa', 'bbbb']);

    await storage.delete('propagation/aaaa');
    assert.deepEqual(await storage.listKeys('propagation'), ['bbbb']);
  });
});

test("Reticulum.saveState()/loadState() persist and reload the identity cache and path table across a simulated restart", async () => {
  await withTempDir(async (dir) => {
    const storage = new NodeFileStorage(dir);

    const rnsA = new Reticulum();
    rnsA.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
    const someIdentity = Identity.create();
    const someHex = crypto.bytesToHex(someIdentity.hash);
    rnsA.identities.set(someHex, { public_key: someIdentity.public, ratchet: someIdentity.ratchetPublic, app_data: new Uint8Array([9, 9]) });

    const destHashHex = crypto.bytesToHex(new Uint8Array(16).fill(0x42));
    const announcePacket = new Uint8Array([1, 2, 3, 4, 5]);
    rnsA.pathTable.set(destHashHex, { hops: 2, receivingInterface: rnsA.interfaces[0], fromPeerId: null, packet: announcePacket, timestamp: Date.now() });

    await rnsA.saveState(storage);

    // A fresh instance, simulating a restart, with no in-memory state of its own.
    const rnsB = new Reticulum();
    await rnsB.loadState(storage);

    const reloadedIdentity = rnsB.identities.get(someHex);
    assert.ok(reloadedIdentity);
    assert.deepEqual(Array.from(reloadedIdentity.public_key), Array.from(someIdentity.public));
    assert.deepEqual(Array.from(reloadedIdentity.app_data), [9, 9]);

    const reloadedPath = rnsB.pathTable.get(destHashHex);
    assert.ok(reloadedPath);
    assert.equal(reloadedPath.hops, 2);
    assert.deepEqual(Array.from(reloadedPath.packet), Array.from(announcePacket));
    // Interface/peer references don't survive a restart — a reloaded entry
    // can still answer a path request from its cached packet, but can't be
    // used for _forward()'s next-hop routing until refreshed by a live announce.
    assert.equal(reloadedPath.receivingInterface, null);
  });
});

test('Destination.saveRatchets()/loadRatchets() persist retained ratchets across a simulated restart, and rotation auto-saves once a storage is attached', async () => {
  await withTempDir(async (dir) => {
    const storage = new NodeFileStorage(dir);

    const rns1 = new Reticulum();
    rns1.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
    const identity = Identity.create();
    const dest1 = new Destination(rns1, identity, Destination.IN, Destination.SINGLE, 'test', 'ratchetstore');
    await dest1.loadRatchets(storage); // nothing saved yet — attaches the storage

    dest1.latestRatchetTime = Date.now() - Destination.RATCHET_INTERVAL_MS - 1;
    dest1._rotateRatchets(); // auto-saves via the attached storage
    assert.equal(dest1.ratchets.length, 2);
    await new Promise((r) => setTimeout(r, 50)); // the auto-save is fire-and-forget

    // Same identity after a "restart": the retained list must survive so
    // messages encrypted against the pre-restart announce still decrypt.
    const rns2 = new Reticulum();
    rns2.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
    const dest2 = new Destination(rns2, identity, Destination.IN, Destination.SINGLE, 'test', 'ratchetstore');
    await dest2.loadRatchets(storage);

    assert.equal(dest2.ratchets.length, 2);
    assert.deepEqual(Array.from(dest2.ratchets[0]), Array.from(dest1.ratchets[0]));
    assert.deepEqual(Array.from(dest2.ratchets[1]), Array.from(dest1.ratchets[1]));
    assert.equal(dest2.latestRatchetTime, dest1.latestRatchetTime);
  });
});

test('PropagationNode.saveState()/loadState() persist and reload the message store, and clean up files for purged messages', async () => {
  await withTempDir(async (dir) => {
    const storage = new NodeFileStorage(dir);

    const rns = new Reticulum();
    rns.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
    const nodeIdentity = Identity.create();
    const node = new propagation.PropagationNode(rns, nodeIdentity, { stampCost: 4 });

    const destHash = new Uint8Array(16).fill(0x11);
    node.messages.set('aaaa', { destinationHash: destHash, envelope: new Uint8Array([1, 2, 3]), stamp: new Uint8Array(32) });
    node.messages.set('bbbb', { destinationHash: destHash, envelope: new Uint8Array([4, 5, 6]), stamp: new Uint8Array(32) });
    await node.saveState(storage);

    const rns2 = new Reticulum();
    rns2.addInterface(new (class extends Interface { connect() {} sendData() {} })('noop'));
    const node2 = new propagation.PropagationNode(rns2, Identity.create());
    await node2.loadState(storage);
    assert.equal(node2.messages.size, 2);
    assert.deepEqual(Array.from(node2.messages.get('aaaa').envelope), [1, 2, 3]);
    assert.deepEqual(Array.from(node2.messages.get('bbbb').envelope), [4, 5, 6]);

    // Purge one message (as a real /get download would) and save again —
    // the corresponding on-disk file should be removed, not left orphaned.
    node.messages.delete('aaaa');
    await node.saveState(storage);
    assert.deepEqual(await storage.listKeys('propagation'), ['bbbb']);
  });
});
