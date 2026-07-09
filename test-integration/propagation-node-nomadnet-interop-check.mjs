// Manual, throwaway check: a real end-user LXMF client (NomadNet, driven via
// nomadnet_driver.py — see that file and nomadnet-interop-check.mjs for why
// NomadNet is driven this way rather than through its TUI) and this JS stack
// exchange messages through a real, unmodified LXMF.LXMRouter propagation
// node (enable_propagation(), test-integration/lxmf_propagation_node.py) —
// three separate real/simulated parties on one shared TCP hub, none of them
// this project's own PropagationNode.
//
//   JS  --propagateLXMF()-->  real LXMRouter node  --sync-->  NomadNet
//   NomadNet --PROPAGATED-->  real LXMRouter node  --syncFromRealPropagationNode()-->  JS
//
// Confirms both directions of client<->propagation-node interop this
// project's own PropagationNode already covers (lxmf-propagation-cross-
// language-check.mjs, propagation-client-interop-check.mjs) also hold when
// the node in the middle is the reference implementation and the other
// client is a real end-user application, not just the bare rns/lxmf
// packages.
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as propagation from '../shared/rns/propagation.js';
import * as protocol from '../shared/rns/protocol.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf nomadnet)');
  process.exit(1);
}

const PORT = 18897;
const NODE_LISTEN_PORT = 18898;
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

const jsIdentity = Identity.create();
const jsSelf = new Destination(rns, jsIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

// --- Spawn the real propagation node ---
rmSync('/tmp/pynode-propagation-nomadnet-check', { recursive: true, force: true });
const node = spawn('python3', [
  'test-integration/lxmf_propagation_node.py',
  '--configdir', '/tmp/pynode-propagation-nomadnet-check',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
  '--listen-port', String(NODE_LISTEN_PORT),
  // The protocol mechanics under test here don't depend on the PoW cost
  // itself (already covered separately by stamp.js's own byte-exact/live
  // tests) — LXMRouter.PROPAGATION_COST_MIN keeps this test's real
  // LXStamper computation (in pure Python, on both the upload and the
  // NomadNet-side PROPAGATED-send legs) from taking many minutes.
  '--propagation-cost', '13',
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});
node.stderr.on('data', (d) => console.error('[node stderr]', d.toString().trim()));

const nodeEvents = [];
const nodeWaiters = [];
function waitForNode(predicate, timeoutMs = 15000) {
  const existing = nodeEvents.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for propagation node event')), timeoutMs);
    nodeWaiters.push({ predicate, resolve, timer });
  });
}
// Unlike waitForNode(), never resolves from a past event already in
// nodeEvents — for polling a repeatable command (like check_store) where
// every response has the same shape and an already-seen one would otherwise
// satisfy the predicate forever.
function waitForNextNode(predicate, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for a new propagation node event')), timeoutMs);
    nodeWaiters.push({ predicate, resolve, timer });
  });
}
node.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    console.log('[node]', line);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    nodeEvents.push(msg);
    for (let i = nodeWaiters.length - 1; i >= 0; i--) {
      if (nodeWaiters[i].predicate(msg)) {
        clearTimeout(nodeWaiters[i].timer);
        nodeWaiters[i].resolve(msg);
        nodeWaiters.splice(i, 1);
      }
    }
  }
});

// --- Spawn the real NomadNet client ---
// NomadNet connects directly to the propagation node's own listen port
// rather than through the JS gateway. This project's own packet forwarding
// (Reticulum._forward()/_forwardLinkRequest()) is a simplified,
// single-hop-only analog of RNS.Transport that never rewrites transport_id
// when relaying — real RNS's Transport.packet_filter() rejects a relayed
// non-announce packet whose transport_id doesn't match the receiving node's
// own transport identity ("in transport for other transport instance"),
// which a genuine three-real-RNS-process relay (NomadNet <-> JS <-> node)
// would hit for the Link handshake between NomadNet and the node. Since
// neither real Link here needs to cross that gap — JS's own Link to the
// node, and NomadNet's own Link to the node, are each direct two-party
// connections — pointing NomadNet at the node's own interface sidesteps it
// entirely, and is also how a real deployment would be configured (an
// end-user client connects directly to a propagation node's address, not
// through some unrelated third party). Announces still cross between JS and
// NomadNet via the node's own interface, since it's a real transport-enabled
// RNS instance and announces are exempt from the transport_id filter.
const nomadConfigDir = '/tmp/propagation-nomadnet-check-cfg';
const nomadRnsConfigDir = '/tmp/propagation-nomadnet-check-rnscfg';
rmSync(nomadConfigDir, { recursive: true, force: true });
rmSync(nomadRnsConfigDir, { recursive: true, force: true });
mkdirSync(nomadRnsConfigDir, { recursive: true });
writeFileSync(`${nomadRnsConfigDir}/config`, `[reticulum]
enable_transport = True
share_instance = False
panic_on_interface_error = False

[logging]
loglevel = 3

[interfaces]
[[Bridge]]
  type = TCPClientInterface
  interface_enabled = True
  target_host = 127.0.0.1
  target_port = ${NODE_LISTEN_PORT}
`);

const nomad = spawn('python3', [
  'test-integration/nomadnet_driver.py',
  '--configdir', nomadConfigDir,
  '--rnsconfigdir', nomadRnsConfigDir,
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});
nomad.stderr.on('data', (d) => console.error('[nomadnet stderr]', d.toString().trim()));

const nomadEvents = [];
const nomadWaiters = [];
function waitForNomad(predicate, timeoutMs = 20000) {
  const existing = nomadEvents.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for nomadnet event')), timeoutMs);
    nomadWaiters.push({ predicate, resolve, timer });
  });
}
nomad.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    console.log('[nomadnet]', line);
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    nomadEvents.push(msg);
    for (let i = nomadWaiters.length - 1; i >= 0; i--) {
      if (nomadWaiters[i].predicate(msg)) {
        clearTimeout(nomadWaiters[i].timer);
        nomadWaiters[i].resolve(msg);
        nomadWaiters.splice(i, 1);
      }
    }
  }
});

const nodeReady = await waitForNode((m) => m.event === 'ready', 15000);
console.log('real LXMRouter propagation node ready:', nodeReady);

// The real LXMRouter node's own get_propagation_node_app_data()-carrying
// announce fires ~20s after enable_propagation() (NODE_ANNOUNCE_DELAY) —
// both JS (for stampCost auto-detection) and NomadNet (for propagation-cost
// lookup when it sends PROPAGATED) need to see it. Start waiting immediately.
const jsSeesNodeAnnounce = new Promise((resolve) => {
  rns.on('announce', function handler(a) {
    if (crypto.bytesToHex(a.destination_hash) === nodeReady.dest_hash) { rns.off('announce', handler); resolve(a); }
  });
});

const nomadReady = await waitForNomad((m) => m.event === 'ready', 15000);
console.log('real nomadnet client ready:', nomadReady);

console.log("waiting for the real LXMRouter node's own propagation announce (~20s)...");
const nodeAnnounce = await jsSeesNodeAnnounce;
const parsedNodeAppData = protocol.lxmf_parse_propagation_announce_app_data(nodeAnnounce.app_data);
assertTrue(!!parsedNodeAppData, "JS parsed the real node's get_propagation_node_app_data()-shaped announce");

// --- JS -> real node -> NomadNet ---
const jsToNomadDest = new Destination(rns, { public: crypto.hexToBytes(nomadReady.public_key) }, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
assertEqual(crypto.bytesToHex(jsToNomadDest.hash), nomadReady.dest_hash, "JS derives the same lxmf.delivery destination hash NomadNet itself reports");

const nodeOutFromJs = new Destination(rns, { public: crypto.hexToBytes(nodeReady.public_key), hash: crypto.hexToBytes(nodeReady.identity_hash) }, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
assertEqual(crypto.bytesToHex(nodeOutFromJs.hash), nodeReady.dest_hash, 'JS derives the same propagation destination hash the real node reports');

const uploadLink = new Link(rns, nodeOutFromJs);
await new Promise((resolve) => uploadLink.once('established', resolve));

const requiredStampCost = Math.max(0, parsedNodeAppData.stampCost - parsedNodeAppData.stampCostFlexibility);
await propagation.propagateLXMF(uploadLink, jsToNomadDest, jsSelf, 'js via real node', 'hello nomadnet, relayed through a real LXMRouter propagation node', {}, requiredStampCost);
uploadLink.close();
console.log('JS upload resource acknowledged by the real node');

// sendResource()'s promise resolves once the transfer's proof is back, which
// can land slightly before the node's own resource_concluded callback has
// finished parsing/storing the message — poll rather than check once.
let storeAfterUpload = null;
for (let i = 0; i < 20; i++) {
  node.stdin.write(`${JSON.stringify({ cmd: 'check_store' })}\n`);
  const status = await waitForNextNode((m) => m.event === 'store_status', 5000);
  if (status.count >= 1) { storeAfterUpload = status; break; }
  await new Promise((r) => setTimeout(r, 500));
}
assertTrue(!!storeAfterUpload, `the real node's store holds the JS-uploaded message (count=${storeAfterUpload?.count ?? 0})`);

const nomadGotSync = waitForNomad((m) => m.event === 'sync_state' && m.state === 7, 90000);
nomad.stdin.write(`${JSON.stringify({ cmd: 'set_propagation_node', dest_hash: nodeReady.dest_hash })}\n`);
nomad.stdin.write(`${JSON.stringify({ cmd: 'sync' })}\n`);
await nomadGotSync;
console.log("NomadNet's sync reached PR_COMPLETE");

// NomadNet has no JSON delivery event — confirm receipt via its own on-disk
// conversation store, same technique as nomadnet-interop-check.mjs.
const conversationDir = `${nomadConfigDir}/storage/conversations/${crypto.bytesToHex(jsSelf.hash)}`;
let nomadReceived = false;
for (let i = 0; i < 100; i++) {
  if (existsSync(conversationDir) && readdirSync(conversationDir).some((f) => !['unread', 'failed'].includes(f))) {
    nomadReceived = true;
    break;
  }
  await new Promise((r) => setTimeout(r, 100));
}
assertTrue(nomadReceived, `NomadNet received and stored the JS message synced through the real propagation node (checked ${conversationDir})`);

// --- NomadNet -> real node -> JS ---
// NomadNet needs to know JS's identity (ratchet included) before it can
// encrypt a PROPAGATED message to it. There's no event confirming NomadNet's
// underlying RNS instance cached it, so give the flooded announce a moment
// to arrive before triggering the send.
jsSelf.announce();
await new Promise((r) => setTimeout(r, 2000));

nomad.stdin.write(`${JSON.stringify({ cmd: 'send_propagated', dest_hash: crypto.bytesToHex(jsSelf.hash), title: 'nomadnet via real node', content: 'hello js, relayed the other way through the same real propagation node' })}\n`);

console.log("waiting for the real node's store to gain the NomadNet-uploaded message (real LXStamper PoW, even at LXMRouter.PROPAGATION_COST_MIN, can take several minutes in pure Python)...");
let nodeGotNomadMessage = false;
for (let i = 0; i < 1200; i++) {
  node.stdin.write(`${JSON.stringify({ cmd: 'check_store' })}\n`);
  const status = await waitForNextNode((m) => m.event === 'store_status', 5000);
  if (status.count >= 2) { nodeGotNomadMessage = true; break; }
  if (i % 10 === 0) {
    nomad.stdin.write(`${JSON.stringify({ cmd: 'debug_status' })}\n`);
  }
  await new Promise((r) => setTimeout(r, 1000));
}
assertTrue(nodeGotNomadMessage, "the real node's store gained a second message (NomadNet's PROPAGATED send)");

const downloadLink = new Link(rns, nodeOutFromJs);
await new Promise((resolve) => downloadLink.once('established', resolve));
const messages = await propagation.syncFromRealPropagationNode(downloadLink, jsSelf);
downloadLink.close();

const fromNomad = messages.find((m) => new TextDecoder().decode(m.title) === 'nomadnet via real node');
assertTrue(!!fromNomad, "JS downloaded the message NomadNet sent via the real propagation node");
if (fromNomad) {
  assertTrue(fromNomad.valid, "the downloaded message's signature validates against NomadNet's real identity");
  assertEqual(new TextDecoder().decode(fromNomad.content), 'hello js, relayed the other way through the same real propagation node', "downloaded message content matches what NomadNet sent");
  assertEqual(crypto.bytesToHex(fromNomad.source_hash), nomadReady.dest_hash, "downloaded message's source_hash matches NomadNet's real lxmf.delivery destination");
}

nomad.kill('SIGKILL'); // NomadNet's own signal/cleanup handling can hang on plain SIGTERM
node.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
