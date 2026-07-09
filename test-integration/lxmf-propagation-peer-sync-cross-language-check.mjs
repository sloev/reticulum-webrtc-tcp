// Verifies syncToPeer()/_onOfferRequest() (shared/rns/propagation.js): this
// project's own PropagationNode acts as the *peer* in a node-to-node sync
// ("/offer" protocol) — offering a message it's holding to a real,
// unmodified LXMF.LXMRouter propagation node (enable_propagation()),
// computing a real peering-key proof-of-work at the node's own required
// peering_cost, and confirming the reference implementation accepts the
// key, accepts the offer, and stores the synced message (with its original
// admission stamp still attached and re-validated, exactly like a fresh
// upload).
//
// This is the peer-sync counterpart to lxmf-propagation-cross-language-
// check.mjs's client upload/download checks — same real node, different
// request path ("/offer" instead of a plain Resource upload, and "/get"
// with a peering key rather than a client's own request).
//
// Run with: PYLIBS=/path/to/site-packages npm run test:integration:lxmf-peer-sync
// (requires: pip install --target=$PYLIBS rns lxmf)
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link, Interface } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as propagation from '../shared/rns/propagation.js';
import * as protocol from '../shared/rns/protocol.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf)');
  process.exit(1);
}

const PORT = 18891;
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

const rnsSender = new Reticulum();
class Bridge extends Interface {
  connect() {}
  sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
}
const ifaceSenderSide = new Bridge('sender');
const ifaceNodeSide = new Bridge('node');
ifaceSenderSide.other = ifaceNodeSide;
ifaceNodeSide.other = ifaceSenderSide;
rnsSender.addInterface(ifaceSenderSide);
rns.addInterface(ifaceNodeSide);

rmSync('/tmp/pynode-lxmf-peer-sync-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/lxmf_propagation_node.py',
  '--configdir', '/tmp/pynode-lxmf-peer-sync-check',
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
let stdoutBuffer = '';
py.stdout.on('data', (d) => {
  stdoutBuffer += d.toString();
  const lines = stdoutBuffer.split('\n');
  stdoutBuffer = lines.pop();
  for (const line of lines) {
    if (!line.trim()) continue;
    console.log('[py]', line.length > 500 ? `${line.slice(0, 500)}... (${line.length} chars)` : line);
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
// waiting for it immediately (compliance.md Phase 5.3), in parallel with the
// rest of setup below.
const realNodeAnnouncePromise = new Promise((resolve) => {
  rns.on('announce', function handler(a) {
    if (crypto.bytesToHex(a.destination_hash) === ready.dest_hash) { rns.off('announce', handler); resolve(a); }
  });
});

// Our own PropagationNode, holding a message uploaded by a local "sender"
// (nothing to do with the real node yet).
const nodeIdentity = Identity.create();
const node = new propagation.PropagationNode(rns, nodeIdentity, { peeringCost: 8 });

const senderIdentity = Identity.create();
const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

// The recipient identity the message is addressed to — the real node never
// learns or needs to know it; it only stores the opaque encrypted envelope.
const recipientIdentity = Identity.create();
rnsSender.identities.set(
  crypto.bytesToHex(new Destination(rnsSender, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery').hash),
  { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic }
);

const senderKnowsNode = new Promise((resolve) => rnsSender.once('announce', resolve));
node.announce();
await senderKnowsNode;

const destOut = new Destination(rnsSender, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
const nodeOutFromSender = new Destination(rnsSender, nodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
const senderLink = new Link(rnsSender, nodeOutFromSender);
await new Promise((resolve) => senderLink.once('established', resolve));

console.log("waiting for the real LXMRouter's own propagation-node announce (compliance.md Phase 5.3, ~20s)...");
const realNodeAnnounce = await realNodeAnnouncePromise;
const parsedRealNodeAppData = protocol.lxmf_parse_propagation_announce_app_data(realNodeAnnounce.app_data);
assertTrue(!!parsedRealNodeAppData, "JS successfully parsed the real LXMRouter's own get_propagation_node_app_data()-shaped announce");
assertEqual(parsedRealNodeAppData?.stampCost, ready.propagation_stamp_cost, "the announce's stamp_cost matches what the node itself reported out of band (cross-checking, not relying on the side channel)");
assertEqual(parsedRealNodeAppData?.peeringCost, ready.peering_cost, "the announce's peering_cost matches");

// Stamp the message at the cost the REAL node will require once it's synced
// there as a peer — peer sync forwards the original stamp unchanged, and the
// real node re-validates it against its own required cost on receipt. Read
// from the real announce just parsed above, not the out-of-band `ready.*`
// fields (an explicit override, since this upload's own destination — our
// local `node` — isn't the same as the real node whose future cost matters
// here; propagateLXMF()'s own auto-detection reads its immediate link's
// destination's announce, which would be the wrong one in this cross-node
// scenario).
const requiredStampCost = Math.max(0, parsedRealNodeAppData.stampCost - parsedRealNodeAppData.stampCostFlexibility);
await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'peer sync interop', 'hello via a real LXMRouter peer', {}, requiredStampCost);
senderLink.close();
assertTrue(node.messages.size === 1, `this stack's own PropagationNode is holding the uploaded message (count=${node.messages.size})`);

// Now our node syncs that message TO the real LXMRouter, as a peer.
const realNodeIdentity = { public: crypto.hexToBytes(ready.public_key), hash: crypto.hexToBytes(ready.identity_hash) };
const realNodeDest = new Destination(rns, realNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
assertEqual(crypto.bytesToHex(realNodeDest.hash), ready.dest_hash, 'JS derives the same propagation destination hash the real LXMRouter reports');

const peerLink = new Link(rns, realNodeDest);
await new Promise((resolve) => peerLink.once('established', resolve));
console.log('real Link established to the reference LXMRouter propagation node, for peer sync');

console.log(`computing a peering key at the announce-derived required cost — this can take several seconds...`);
const t0 = Date.now();
// No peeringCost argument — syncToPeer() reads it from the real node's own
// announce (peerLink's destination), already cached above.
const result = await propagation.syncToPeer(node, peerLink, realNodeIdentity);
console.log(`peering key computed and sync completed in ${Date.now() - t0}ms:`, result);

assertTrue(result.offered === 1, `syncToPeer() offered exactly 1 message (offered=${result.offered})`);
assertTrue(result.synced === 1, `syncToPeer() synced exactly 1 message (synced=${result.synced})`);

await new Promise((r) => setTimeout(r, 500));
py.stdin.write(JSON.stringify({ cmd: 'check_store' }) + '\n');
const status = await waitFor((m) => m.event === 'store_status', 10000);
assertTrue(status.count >= 1, `the real LXMRouter's message store contains at least one message after peer sync (count=${status.count})`);

peerLink.close();
py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
