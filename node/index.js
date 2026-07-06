import { Reticulum } from '../shared/rns/index.js';
import { WebRTCNode } from './webrtc-node.js';
import { createTCPGateway } from './tcp-gateway.js';
import { NodeFileStorage } from '../shared/rns/storage.js';

const rns = new Reticulum();

// Opt-in persistence (compliance.md Phase 7 — an adaptation for surviving
// restarts, not a wire-format compliance concern): set RNS_STORAGE_DIR to
// reload the identity cache/path table on startup and save them
// periodically and on shutdown. Without it, state is in-memory only, same
// as before.
const storageDir = process.env.RNS_STORAGE_DIR;
const storage = storageDir ? new NodeFileStorage(storageDir) : null;
if (storage) {
    await rns.loadState(storage);
    const saveInterval = setInterval(() => rns.saveState(storage), 5 * 60 * 1000);
    saveInterval.unref();
    for (const signal of ['SIGINT', 'SIGTERM']) {
        process.on(signal, async () => {
            await rns.saveState(storage);
            process.exit(0);
        });
    }
}

const webrtc = new WebRTCNode();
rns.addInterface(webrtc);

createTCPGateway(4242, rns);
