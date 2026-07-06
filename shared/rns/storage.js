// A minimal storage adapter for persisting this project's in-memory state
// (identity cache, path table, propagation node messages) across restarts —
// an *adaptation*, not a wire-format compliance concern (see README's
// Compliance section): unlike RNS's own on-disk formats (`RNS.Identity.
// remember`/`recall`'s known_destinations file, `LXMRouter`'s storagepath
// layout), nothing else ever reads this directly off disk, so the format
// here only needs to round-trip with this project's own Reticulum.
// loadState()/saveState() and PropagationNode.loadState()/saveState() (see
// shared/rns/index.js, shared/rns/propagation.js).
//
// Node.js only. A browser adapter (e.g. IndexedDB) would implement the same
// save(key, value)/load(key)/listKeys(prefix) interface — the browser demo's
// existing sessionStorage-based identity caching (browser/main.js) already
// covers the one thing worth persisting in a page that's otherwise fully
// reset on close, so no browser adapter is implemented here.
import { pack, unpack } from 'msgpackr';
import { mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

export class NodeFileStorage {
    constructor(configDir) {
        this.configDir = configDir;
    }

    async save(key, value) {
        const path = join(this.configDir, `${key}.msgpack`);
        await mkdir(join(path, '..'), { recursive: true });
        await writeFile(path, pack(value));
    }

    async load(key) {
        try {
            return unpack(await readFile(join(this.configDir, `${key}.msgpack`)));
        } catch {
            return null;
        }
    }

    async delete(key) {
        await rm(join(this.configDir, `${key}.msgpack`), { force: true });
    }

    // Lists the keys of everything previously saved under `prefix/` (see
    // PropagationNode's one-file-per-message layout) — returns bare keys
    // (without the .msgpack suffix or prefix), or [] if the directory
    // doesn't exist yet.
    async listKeys(prefix) {
        try {
            const entries = await readdir(join(this.configDir, prefix));
            return entries.filter((f) => f.endsWith('.msgpack')).map((f) => f.slice(0, -'.msgpack'.length));
        } catch {
            return [];
        }
    }
}
