// Manual, throwaway check: this JS stack's propagateLXMF() uploads a real
// LXMF message to an actual LXMF.LXMRouter propagation node (the reference
// implementation, with enable_propagation() — not this repo's own
// PropagationNode), over a real RNS.Link + Resource transfer, with a real
// proof-of-work admission stamp computed at the node's own required cost.
// Confirms the real propagation node accepts, validates the stamp, and
// stores the message under the same transient_id this JS stack computes
// independently — genuine upload-side interop with the reference
// implementation, not just this project's own PropagationNode.
//
// Also confirms the download/sync half now works too:
// syncFromRealPropagationNode() (shared/rns/propagation.js) uses
// Link.identify() to prove the recipient's identity to the node exactly
// like a real LXMRouter client does, then fetches the same message back
// over the node's real "/get" request path and decrypts/parses it.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as propagation from '../shared/rns/propagation.js';
import * as protocol from '../shared/rns/protocol.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf)');
  process.exit(1);
}

const PORT = 18890;
let failed = false;
function assertTrue(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failed = true;
}
function assertEqual(actual, expected, msg) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}: ${msg}`, ok ? '' : `(got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
  if (!ok) failed = true;
}

const rns = new Reticulum();
const gateway = createTCPGateway(PORT, rns);

rmSync('/tmp/pynode-lxmf-propagation-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/lxmf_propagation_node.py',
  '--configdir', '/tmp/pynode-lxmf-propagation-check',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[py stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 15000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for python event')), timeoutMs);
    waiters.push({ predicate, resolve, timer });
  });
}
py.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    console.log('[py]', line);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    events.push(msg);
    for (let i = waiters.length - 1; i >= 0; i--) {
      if (waiters[i].predicate(msg)) {
        clearTimeout(waiters[i].timer);
        waiters[i].resolve(msg);
        waiters.splice(i, 1);
      }
    }
  }
});

const ready = await waitFor((m) => m.event === 'ready', 15000);
console.log('real LXMRouter propagation node ready:', ready);

// The real LXMRouter fires its own get_propagation_node_app_data()-carrying
// announce ~20s after enable_propagation() (NODE_ANNOUNCE_DELAY) — start
// waiting for it immediately, in parallel with the rest of setup below, so
// this test doesn't serialize an extra 20s wait on top of everything else.
const nodeAnnouncePromise = new Promise((resolve) => {
  rns.on('announce', function handler(a) {
    if (crypto.bytesToHex(a.destination_hash) === ready.dest_hash) { rns.off('announce', handler); resolve(a); }
  });
});

// A local, made-up "recipient" identity — the propagation node never learns
// or needs to know it; it only stores the opaque encrypted envelope, keyed
// by destination hash.
const recipientIdentity = Identity.create();
const recipientSelf = new Destination(rns, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
rns.identities.set(crypto.bytesToHex(recipientSelf.hash), { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic });

const senderIdentity = Identity.create();
const senderSelf = new Destination(rns, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
// So the recipient's later tryParseLxmf() (on download) can validate the
// sender's signature — in real use this would come from an earlier announce.
rns.identities.set(crypto.bytesToHex(senderSelf.hash), { public_key: senderIdentity.public, ratchet: senderIdentity.ratchetPublic });

const destOut = new Destination(rns, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

const pythonIdentity = { public: crypto.hexToBytes(ready.public_key) };
const propNodeDest = new Destination(rns, pythonIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
assertTrue(crypto.bytesToHex(propNodeDest.hash) === ready.dest_hash, 'JS derives the same propagation destination hash the real LXMRouter reports');

const link = new Link(rns, propNodeDest);
await new Promise((resolve) => link.once('established', resolve));
console.log('real Link established to the reference LXMRouter propagation node');

console.log("waiting for the real LXMRouter's own propagation-node announce (compliance.md Phase 5.3, ~20s)...");
const nodeAnnounce = await nodeAnnouncePromise;
const parsedNodeAppData = protocol.lxmf_parse_propagation_announce_app_data(nodeAnnounce.app_data);
assertTrue(!!parsedNodeAppData, "JS successfully parsed the real LXMRouter's own get_propagation_node_app_data()-shaped announce");
assertEqual(parsedNodeAppData?.stampCost, ready.propagation_stamp_cost, "the announce's stamp_cost matches what the node itself reported out of band (cross-checking, not relying on the side channel)");
assertEqual(parsedNodeAppData?.stampCostFlexibility, ready.propagation_stamp_cost_flexibility, "the announce's stamp_cost_flexibility matches");
assertEqual(parsedNodeAppData?.peeringCost, ready.peering_cost, "the announce's peering_cost matches");

console.log(`computing a stamp at the announce-derived minimum accepted cost — this can take several seconds...`);
const t0 = Date.now();
// No stampCost argument — propagateLXMF() reads it from the real announce
// just parsed above (cached in rns.identities by the announce handler),
// instead of the out-of-band `ready.propagation_stamp_cost` used previously.
await propagation.propagateLXMF(link, destOut, senderSelf, 'real interop', 'hello real LXMRouter', {});
console.log(`stamp computed and resource uploaded in ${Date.now() - t0}ms`);

await new Promise((r) => setTimeout(r, 500));
py.stdin.write(JSON.stringify({ cmd: 'check_store' }) + '\n');
const status = await waitFor((m) => m.event === 'store_status', 10000);

assertTrue(status.count >= 1, `the real LXMRouter's message store contains at least one message (count=${status.count})`);

// --- Upload a few more, larger messages, so the eventual "/get" download
// response is too big for a single packet — exercising Link.request()'s
// Resource fallback (compliance.md Phase 3) against a real LXMRouter's own
// "/get" response, not just a synthetic Resource transfer. ---
const bulkContent = 'padding to make this message large enough to force a multi-message /get response over LINK_MDU. '.repeat(8);
for (let i = 0; i < 3; i++) {
  const bulkLink = new Link(rns, propNodeDest);
  await new Promise((resolve) => bulkLink.once('established', resolve));
  await propagation.propagateLXMF(bulkLink, destOut, senderSelf, `bulk ${i}`, bulkContent, {});
  bulkLink.close();
}
console.log('uploaded 3 additional bulk messages');

// --- Download/sync: the recipient identifies to the real node over a fresh
// Link (Link.identify()), then fetches the message back via the node's real
// "/get" request path ---
const downloadLink = new Link(rns, propNodeDest);
await new Promise((resolve) => downloadLink.once('established', resolve));
console.log('second real Link established for the download/sync half');

const messages = await propagation.syncFromRealPropagationNode(downloadLink, recipientSelf);
assertTrue(messages.length >= 4, `syncFromRealPropagationNode() got all 4 messages back, over a "/get" response too large for one packet — Link.request()'s Resource fallback (count=${messages.length})`);
const original = messages.find((m) => new TextDecoder().decode(m.title) === 'real interop');
assertTrue(!!original, 'the original single-packet-sized message is among those downloaded');
if (original) {
  assertTrue(original.valid, "the downloaded message's signature validates against the sender's identity");
  assertEqual(new TextDecoder().decode(original.content), 'hello real LXMRouter', 'downloaded message content matches what was uploaded');
  assertEqual(crypto.bytesToHex(original.source_hash), crypto.bytesToHex(senderSelf.hash), "downloaded message's source_hash matches the real sender");
}
const bulkMessages = messages.filter((m) => new TextDecoder().decode(m.title).startsWith('bulk '));
assertEqual(bulkMessages.length, 3, 'all 3 bulk messages are among those downloaded');
assertTrue(bulkMessages.every((m) => new TextDecoder().decode(m.content) === bulkContent), 'every bulk message\'s content matches what was uploaded');

link.close();
downloadLink.close();
py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
