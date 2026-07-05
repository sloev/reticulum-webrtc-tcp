// LXMF propagation stamps (LXStamper): a hashcash-style proof-of-work that a
// propagation node can require before accepting an uploaded message, so
// flooding a node with junk costs the sender real CPU time per message.
// Matches LXStamper's exact algorithm — the workblock derivation (repeated
// HKDF-SHA256 keyed by the message's transient_id, with a per-round salt)
// and the stamp validity check (full_hash(workblock+stamp) interpreted as a
// big-endian integer, must have at least `target_cost` leading zero bits) —
// so the *cost* of a given target_cost is the same as in real LXMF. What's
// not implemented: peering-key stamps (LXMPeer node-to-node sync isn't
// implemented either — see propagation.js) and multi-process/worker-thread
// parallel search (LXStamper spawns OS processes to search faster; this
// runs single-threaded, so the same target_cost takes longer here than in
// the reference implementation).
import * as crypto from './crypto.js';
import * as msgpack from './msgpack.js';

export const STAMP_SIZE = 32; // full_hash length
// Matches LXStamper.WORKBLOCK_EXPAND_ROUNDS_PN — the round count used for
// propagation-node message stamps specifically (as opposed to the higher
// round count LXMF uses for peer-to-peer message stamps, or the lower one
// for peering keys — neither of those is implemented here).
export const WORKBLOCK_EXPAND_ROUNDS_PN = 1000;

// A large, deterministic pseudo-random blob derived from `material` (a
// message's transient_id): both generating and validating a stamp require
// recomputing this same expensive derivation, which is what makes a stamp
// costly to produce but cheap to check once.
export function stamp_workblock(material, expand_rounds = WORKBLOCK_EXPAND_ROUNDS_PN) {
    const parts = [];
    for (let n = 0; n < expand_rounds; n++) {
        const salt = crypto.sha256(crypto.concat(material, msgpack.pack(n)));
        parts.push(crypto.hkdf(material, 256, salt));
    }
    return crypto.concat(...parts);
}

// The number of leading zero bits of full_hash(workblock+stamp), i.e. how
// much work a given stamp actually demonstrates (which can exceed the
// minimum target_cost a validator required).
export function stamp_value(workblock, stamp) {
    const result = crypto.sha256(crypto.concat(workblock, stamp));
    let leadingZeros = 0;
    for (const byte of result) {
        if (byte === 0) {
            leadingZeros += 8;
            continue;
        }
        for (let bit = 7; bit >= 0; bit--) {
            if ((byte >> bit) & 1) return leadingZeros;
            leadingZeros++;
        }
    }
    return leadingZeros;
}

export function stamp_valid(stamp, target_cost, workblock) {
    return stamp_value(workblock, stamp) >= target_cost;
}

// Brute-forces random 32-byte stamps against material's workblock until one
// meets target_cost, returning { stamp, value, attempts }. Cost grows
// exponentially with target_cost (expect roughly 2^target_cost attempts) —
// keep target_cost modest unless you want this to run for a long time (see
// the module comment above re: no parallel search).
export function generate_stamp(material, target_cost, expand_rounds = WORKBLOCK_EXPAND_ROUNDS_PN) {
    const workblock = stamp_workblock(material, expand_rounds);
    let attempts = 0;
    for (;;) {
        const stamp = crypto.randomBytes(STAMP_SIZE);
        attempts++;
        const value = stamp_value(workblock, stamp);
        if (value >= target_cost) return { stamp, value, attempts };
    }
}
