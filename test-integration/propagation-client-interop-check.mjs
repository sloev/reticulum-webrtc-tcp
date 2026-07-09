// Verifies PropagationNode._onRealGetRequest() (shared/rns/propagation.js)
// against a real, unmodified LXMF client (LXMF.LXMRouter, no
// enable_propagation()): it syncs a message stored on this project's own
// PropagationNode using the client's real propagation-node sync protocol
// (set_outbound_propagation_node()/request_messages_from_propagation_node(),
// the "/get" request path with Link.identify()-based auth) rather than this
// project's JS-only syncLXMF() scheme — the counterpart to
// syncFromRealPropagationNode(), which covers this stack acting as the
// client against a real node (see lxmf-propagation-cross-language-check.mjs).
//
// Run with: PYLIBS=/path/to/site-packages npm run test:integration:propagation-client
// (requires: pip install --target=$PYLIBS rns lxmf)
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link, Interface } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as propagation from '../shared/rns/propagation.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf)');
  process.exit(1);
}

const PORT = 18896;
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

const propNodeIdentity = Identity.create();
const propNode = new propagation.PropagationNode(rns, propNodeIdentity);

// The sender lives on a separate, bridged Reticulum instance — like
// lxmf-propagation-peer-sync-cross-language-check.mjs, this keeps the
// "someone uploads to a node" and "the node itself" roles distinct, matching
// how these would actually be separate processes.
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

// Buffered before anything can possibly arrive, so a fast announce (e.g. the
// real client's own startup announce, or propNode's rebroadcast through the
// bridge) can't be missed by a listener registered too late.
const rnsSenderAnnounces = [];
rnsSender.on('announce', (a) => rnsSenderAnnounces.push(a));
function waitForSenderAnnounce(predicate, timeoutMs = 5000) {
  const existing = rnsSenderAnnounces.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for a JS-side announce')), timeoutMs);
    const handler = (a) => {
      if (predicate(a)) {
        clearTimeout(timer);
        rnsSender.off('announce', handler);
        resolve(a);
      }
    };
    rnsSender.on('announce', handler);
  });
}

const senderIdentity = Identity.create();
const senderSelf = new Destination(rnsSender, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

rmSync('/tmp/pynode-propagation-client-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/lxmf_propagation_client.py',
  '--configdir', '/tmp/pynode-propagation-client-check',
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
console.log('real LXMF client ready:', ready);

// Cross-announce: the client needs to see PropagationNode's announce to
// select it as an outbound propagation node; JS needs to see the client's
// own real announce (fired at its startup) to learn its ratchet-enabled
// identity well enough to encrypt a message to it; the sender-side instance
// needs both, via the bridge's flood.
const clientGotNodeAnnounce = waitFor((m) => m.event === 'announce_received' && m.dest_hash === crypto.bytesToHex(propNode.destination.hash), 5000);
const senderKnowsNode = waitForSenderAnnounce((a) => crypto.bytesToHex(a.destination_hash) === crypto.bytesToHex(propNode.destination.hash), 5000);
propNode.announce();
await Promise.all([clientGotNodeAnnounce, senderKnowsNode]);

const clientGotSenderAnnounce = waitFor((m) => m.event === 'announce_received' && m.dest_hash === crypto.bytesToHex(senderSelf.hash), 5000);
senderSelf.announce();
await clientGotSenderAnnounce;

const senderKnowsClient = await waitForSenderAnnounce((a) => crypto.bytesToHex(a.destination_hash) === ready.dest_hash, 5000);
console.log("JS learned the real client's ratchet-enabled identity via its own real announce");

const destOut = new Destination(rnsSender, { public: crypto.hexToBytes(ready.public_key) }, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
assertEqual(crypto.bytesToHex(destOut.hash), ready.dest_hash, 'JS derives the same lxmf.delivery destination hash the real client reports');

const nodeOutFromSender = new Destination(rnsSender, propNodeIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
const senderLink = new Link(rnsSender, nodeOutFromSender);
await new Promise((resolve) => senderLink.once('established', resolve));

await propagation.propagateLXMF(senderLink, destOut, senderSelf, 'real client interop', "hello real LXMF client, synced through this stack's own PropagationNode", {});
senderLink.close();
assertTrue(propNode.messages.size === 1, `PropagationNode is holding the uploaded message (count=${propNode.messages.size})`);

// The real client selects our node and syncs — exercising
// _onRealGetRequest()'s list/fetch/purge handling of the exact request
// shapes LXMRouter.message_get_request()/message_list_response()/
// message_get_response() send.
const clientGotDelivery = waitFor((m) => m.event === 'lxmf_received', 20000);
py.stdin.write(`${JSON.stringify({ cmd: 'set_node', dest_hash: crypto.bytesToHex(propNode.destination.hash) })}\n`);
py.stdin.write(`${JSON.stringify({ cmd: 'sync' })}\n`);

const delivered = await clientGotDelivery;
assertTrue(delivered.valid, "the real LXMF client validated the JS-signed message's signature");
assertEqual(delivered.title, 'real client interop', 'the real LXMF client received the correct title');
assertEqual(delivered.content, "hello real LXMF client, synced through this stack's own PropagationNode", 'the real LXMF client received the correct content');
assertEqual(delivered.source_hash, crypto.bytesToHex(senderSelf.hash), "the delivered message's source_hash matches the real sender");

// LXMRouter purges a message from the node with a separate, later "/get"
// request (data = [None, haves]) once locally delivered — give that a
// moment to land.
await new Promise((r) => setTimeout(r, 1000));
assertTrue(propNode.messages.size === 0, 'PropagationNode purged the message once the real client fetched and confirmed it');

py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
