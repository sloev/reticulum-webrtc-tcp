// Manual check: spawn a real Python RNS node, connect it to this project's
// TCP gateway over actual TCP+HDLC, and confirm an announce it sends gets
// validated by this stack's Reticulum implementation. A minimal smoke test;
// the other test-integration/*-cross-language-check.mjs scripts cover this
// wire format more thoroughly.
//
// Run with: PYLIBS=/path/to/site-packages node test-integration/manual-tcp-check.mjs
// (requires: pip install --target=$PYLIBS rns)
import { spawn } from 'node:child_process';
import { Reticulum, Identity, Destination } from '../shared/rns/index.js';
import { createTCPGateway } from '../node/tcp-gateway.js';
import * as crypto from '../shared/rns/crypto.js';

const PYLIBS = process.env.PYLIBS;
const PORT = 18842;

const rns = new Reticulum();
const gateway = createTCPGateway(PORT, rns);

rns.on('announce', (a) => {
  console.log('[JS] got announce for dest', crypto.bytesToHex(a.destination_hash), 'pubkey', crypto.bytesToHex(a.public_key).slice(0, 16) + '...');
});

const configdir = '/tmp/pynode-manual-check';
const py = spawn('python3', [
  'test-integration/rns_node.py',
  '--configdir', configdir,
  '--app-name', 'test',
  '--aspect', 'integration',
  '--tcp-target-host', '127.0.0.1',
  '--tcp-target-port', String(PORT),
], {
  env: { ...process.env, PYTHONPATH: PYLIBS },
  cwd: new URL('..', import.meta.url).pathname,
});

py.stderr.on('data', (d) => console.error('[py stderr]', d.toString()));
py.stdout.on('data', (d) => {
  for (const line of d.toString().split('\n')) {
    if (!line.trim()) continue;
    console.log('[py]', line);
    const msg = JSON.parse(line);
    if (msg.event === 'ready') {
      setTimeout(() => py.stdin.write(JSON.stringify({ cmd: 'announce' }) + '\n'), 1000);
    }
  }
});

setTimeout(() => {
  console.log('done, exiting');
  py.kill();
  gateway.server.close();
  process.exit(0);
}, 6000);
