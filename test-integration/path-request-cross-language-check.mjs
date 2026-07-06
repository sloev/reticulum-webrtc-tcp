// Manual, throwaway check: this JS stack's Reticulum.requestPath() now sends
// RNS.Transport.request_path()'s 3-field form (destination_hash +
// transport_id + tag) by default — matching real RNS's transport-enabled
// behavior, using a persistent transportIdentity (compliance.md Phase 4).
// Confirms a real Python `rns` process's own path_request_handler() parses
// that 3-field payload correctly (rather than misreading the transport ID
// bytes as part of the tag, or erroring) and answers with a valid announce
// for a destination it owns — genuine wire-format interop, not just a
// byte-exact unit test against a hand-built reference packet.
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { Reticulum } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns)');
  process.exit(1);
}

const PORT = 18895;
let failed = false;
function assertTrue(cond, msg) {
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${msg}`);
  if (!cond) failed = true;
}

const rns = new Reticulum();
const gateway = createTCPGateway(PORT, rns);

rmSync('/tmp/pynode-path-request-check', { recursive: true, force: true });
const py = spawn('python3', [
  'test-integration/rns_node.py',
  '--configdir', '/tmp/pynode-path-request-check',
  '--app-name', 'test',
  '--aspect', 'pathrequestcheck',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[py stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 10000) {
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

const ready = await waitFor((m) => m.event === 'ready', 10000);
console.log('real rns node ready:', ready);
const destHashBytes = crypto.hexToBytes(ready.dest_hash);

// Give the TCP gateway a moment to register the client socket.
await new Promise((r) => setTimeout(r, 500));

const gotAnnounce = new Promise((resolve) => rns.once('announce', resolve));
rns.requestPath(destHashBytes);
const announce = await gotAnnounce;

assertTrue(
  crypto.bytesToHex(announce.destination_hash) === ready.dest_hash,
  "real rns correctly parsed this stack's 3-field path request and answered with an announce for the requested destination"
);
assertTrue(rns.identities.has(ready.dest_hash), "the announce populated this stack's identity cache for the real node's destination");

// A second requestPath() call for the same destination, immediately after,
// must be suppressed by the PATH_REQUEST_MI throttle rather than sent again.
let secondSent = false;
const originalSendData = rns.interfaces[0].sendData.bind(rns.interfaces[0]);
rns.interfaces[0].sendData = (data) => { secondSent = true; originalSendData(data); };
rns.requestPath(destHashBytes);
rns.interfaces[0].sendData = originalSendData;
assertTrue(!secondSent, 'a repeat requestPath() call for the same destination within PATH_REQUEST_MI is suppressed, not resent to the real node');

py.kill();
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
