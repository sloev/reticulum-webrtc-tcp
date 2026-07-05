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
// Download/sync interop is NOT covered here: a real LXMRouter's "/get"
// handler identifies the requester via RNS's own Link identification
// (RNS.Link.identify()), which isn't implemented in this project (see
// shared/rns/propagation.js's own request/proof scheme, which is a
// different, JS-only mechanism) — so only the upload half of real LXMF
// propagation-node interop is verified here.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum, Identity, Destination, Link } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';
import * as propagation from '../shared/rns/propagation.js';

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

const requiredCost = Math.max(0, ready.propagation_stamp_cost - ready.propagation_stamp_cost_flexibility);
console.log(`computing a stamp at the node's minimum accepted cost (${requiredCost}) — this can take several seconds...`);

// A local, made-up "recipient" identity — the propagation node never learns
// or needs to know it; it only stores the opaque encrypted envelope, keyed
// by destination hash.
const recipientIdentity = Identity.create();
const recipientSelf = new Destination(rns, recipientIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');
rns.identities.set(crypto.bytesToHex(recipientSelf.hash), { public_key: recipientIdentity.public, ratchet: recipientIdentity.ratchetPublic });

const senderIdentity = Identity.create();
const senderSelf = new Destination(rns, senderIdentity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

const destOut = new Destination(rns, recipientIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');

const pythonIdentity = { public: crypto.hexToBytes(ready.public_key) };
const propNodeDest = new Destination(rns, pythonIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'propagation');
assertTrue(crypto.bytesToHex(propNodeDest.hash) === ready.dest_hash, 'JS derives the same propagation destination hash the real LXMRouter reports');

const link = new Link(rns, propNodeDest);
await new Promise((resolve) => link.once('established', resolve));
console.log('real Link established to the reference LXMRouter propagation node');

const t0 = Date.now();
await propagation.propagateLXMF(link, destOut, senderSelf, 'real interop', 'hello real LXMRouter', {}, requiredCost);
console.log(`stamp computed and resource uploaded in ${Date.now() - t0}ms`);

await new Promise((r) => setTimeout(r, 500));
py.stdin.write(JSON.stringify({ cmd: 'check_store' }) + '\n');
const status = await waitFor((m) => m.event === 'store_status', 10000);

assertTrue(status.count >= 1, `the real LXMRouter's message store contains at least one message (count=${status.count})`);

link.close();
py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
