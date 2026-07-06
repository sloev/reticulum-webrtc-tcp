// Manual, throwaway check: this JS stack talking to a real, unmodified
// `sbapp` (Sideband) client — an actual end-user LXMF client, not just the
// bare `rns`/`lxmf` libraries this repo's other integration checks use
// (compliance.md Phase 6).
//
// Corrects an assumption in compliance.md's own original Phase 6 plan:
// Sideband (a Kivy/KivyMD GUI app) was expected to be infeasible headless.
// It isn't — `sbapp/main.py`'s entire Kivy/KivyMD/LXST(audio) import block
// is gated behind `if not args.daemon:`, so its real `-d`/`--daemon` mode
// never touches Kivy's graphics stack at all (confirmed by running it
// directly first, with no virtual display, before writing this check).
//
// Confirms:
//   1. JS -> Sideband: Sideband's real, unmodified `SidebandCore` (the same
//      object `sbapp -d` itself constructs) receives and delivery-confirms
//      an OPPORTUNISTIC LXMF message sent by this stack.
//   2. Sideband -> JS: Sideband has no scriptable send API exposed as a CLI
//      command, so this direction is driven via test-integration/
//      sideband_driver.py, which calls SidebandCore's own public
//      `send_message()` — the exact method Sideband's UI "send" button
//      calls internally — rather than a synthetic LXMF payload. Notably,
//      send_message() itself defaults to LXMF's DIRECT method (a real
//      Link) rather than OPPORTUNISTIC when no ratchet is yet known for the
//      recipient, so this also genuinely exercises this stack's DIRECT
//      delivery (Phase 5.1) against a real end-user client, not just
//      bare `lxmf`.
//
// Requires: pip install --target=$PYLIBS sbapp (in addition to rns/lxmf).
import { spawn } from 'node:child_process';
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { Reticulum, Identity, Destination } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
if (!PYLIBS) {
  console.error('Set PYLIBS=/path/to/site-packages (pip install --target=<dir> rns lxmf sbapp)');
  process.exit(1);
}

const PORT = 18991;
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

const identity = Identity.create();
const self = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'lxmf', 'delivery');

const sidebandConfigDir = '/tmp/sideband-interop-check-cfg';
const sidebandRnsConfigDir = '/tmp/sideband-interop-check-rnscfg';
rmSync(sidebandConfigDir, { recursive: true, force: true });
rmSync(sidebandRnsConfigDir, { recursive: true, force: true });
mkdirSync(sidebandRnsConfigDir, { recursive: true });
writeFileSync(`${sidebandRnsConfigDir}/config`, `[reticulum]
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
  target_port = ${PORT}
`);

const py = spawn('python3', [
  'test-integration/sideband_driver.py',
  '--configdir', sidebandConfigDir,
  '--rnsconfigdir', sidebandRnsConfigDir,
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[sideband stderr]', d.toString().trim()));

const events = [];
const waiters = [];
function waitFor(predicate, timeoutMs = 20000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for sideband event')), timeoutMs);
    waiters.push({ predicate, resolve, timer });
  });
}
py.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    console.log('[sideband]', line);
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

const ready = await waitFor((m) => m.event === 'ready', 20000);
console.log('real sideband client ready:', ready);

// --- JS -> Sideband ---
const sidebandIdentity = { public: crypto.hexToBytes(ready.public_key) };
const sidebandDest = new Destination(rns, sidebandIdentity, Destination.OUT, Destination.SINGLE, 'lxmf', 'delivery');
assertEqual(crypto.bytesToHex(sidebandDest.hash), ready.dest_hash, "JS derives the same lxmf.delivery destination hash Sideband itself reports");
// Sideband's own JSON output doesn't include an announce; its identity is
// already known here from the "ready" event's public_key (equivalent to what
// a real announce would have provided) so JS can encrypt to it directly.
rns.identities.set(ready.dest_hash, { public_key: sidebandIdentity.public, ratchet: null });

// Sideband needs to know JS's identity (from an announce) before it can
// address a Link/message back to it later.
const sidebandGotAnnounce = new Promise((resolve) => {
  // No JSON event channel from Sideband for this — just give its real
  // Reticulum instance a moment to receive and cache the announce.
  self.announce();
  setTimeout(resolve, 1000);
});
await sidebandGotAnnounce;

const sidebandGotLxmf = waitFor((m) => m.event === 'lxmf_received', 10000);
sidebandDest.sendLXMF(self, 'hello from JS', 'this is a real lxmf message sent to an actual sideband client', {});

const sidebandReceived = await sidebandGotLxmf;
assertTrue(sidebandReceived.valid, "Sideband's real, unmodified router validated the JS-signed LXMF message");
assertEqual(sidebandReceived.content, 'this is a real lxmf message sent to an actual sideband client', 'Sideband received the correct content from JS');

// --- Sideband -> JS ---
const jsGotLxmf = new Promise((resolve) => self.once('lxmf', resolve));
py.stdin.write(JSON.stringify({ cmd: 'send_to', dest_hash: crypto.bytesToHex(self.hash), content: 'this is a real lxmf message sent via a real sideband client' }) + '\n');

const jsReceived = await jsGotLxmf;
assertTrue(jsReceived.valid, "JS validated the signature of a message sent via a real Sideband client's own send_message()");
assertEqual(new TextDecoder().decode(jsReceived.content), 'this is a real lxmf message sent via a real sideband client', 'JS received the correct content from Sideband');

py.kill('SIGKILL'); // Sideband's own signal/cleanup handling can hang on plain SIGTERM
gateway.server.close();

if (failed) {
  console.log('\nRESULT: FAIL');
  process.exit(1);
} else {
  console.log('\nRESULT: PASS');
  process.exit(0);
}
