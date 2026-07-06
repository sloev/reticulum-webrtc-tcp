// LXMF propagation stamps (LXStamper): a hashcash-style proof-of-work that a
// propagation node can require before accepting an uploaded message, so
// flooding a node with junk costs the sender real CPU time per message.
// Matches LXStamper's exact algorithm — the workblock derivation (repeated
// HKDF-SHA256 keyed by the message's transient_id, with a per-round salt)
// and the stamp validity check (full_hash(workblock+stamp) interpreted as a
// big-endian integer, must have at least `target_cost` leading zero bits) —
// so the *cost* of a given target_cost is the same as in real LXMF.
//
// Also implements peering-key stamps (see generate_peering_key()/
// validate_peering_key() below), the same proof-of-work idea applied to a
// node-to-node peering relationship instead of a single message — used by
// propagation.js's node-to-node sync ("/offer" protocol).
//
// Not implemented: multi-process/worker-thread parallel search (LXStamper
// spawns OS processes to search faster; this runs single-threaded, so the
// same target_cost takes longer here than in the reference implementation).
// generate_stamp() does periodically yield to the event loop (see below) so
// a long search doesn't starve everything else — e.g. a Link's own
// keepalives, which (unlike LXStamper's separate-process search) would
// otherwise silently stop being sent for the whole duration of a search on
// this single-threaded runtime, risking a real peer legitimately timing out
// the link.
import * as crypto from './crypto.js';
import * as msgpack from './msgpack.js';

export const STAMP_SIZE = 32; // full_hash length
// Matches LXStamper.WORKBLOCK_EXPAND_ROUNDS_PN — the round count used for
// propagation-node message stamps specifically (as opposed to the higher
// round count LXMF uses for peer-to-peer message stamps, which isn't
// implemented here).
export const WORKBLOCK_EXPAND_ROUNDS_PN = 1000;
// Matches LXStamper.WORKBLOCK_EXPAND_ROUNDS_PEERING — the (much cheaper)
// round count used for a peering key, since it's generated once per peer
// relationship rather than once per message.
export const WORKBLOCK_EXPAND_ROUNDS_PEERING = 25;

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
export async function generate_stamp(material, target_cost, expand_rounds = WORKBLOCK_EXPAND_ROUNDS_PN) {
    const workblock = stamp_workblock(material, expand_rounds);
    let attempts = 0;
    let lastYield = Date.now();
    for (;;) {
        const stamp = crypto.randomBytes(STAMP_SIZE);
        attempts++;
        const value = stamp_value(workblock, stamp);
        if (value >= target_cost) return { stamp, value, attempts };

        if (Date.now() - lastYield > 15) {
            await new Promise((resolve) => setTimeout(resolve, 0));
            lastYield = Date.now();
        }
    }
}

// A peering key proves proof-of-work tied to a specific (responder,
// requester) node pair, rather than to a single message — matches
// LXStamper's `validate_peering_key(peering_id, peering_key, target_cost)`,
// where `peering_id` is always `responder_identity.hash + requester_
// identity.hash`, computed the same way by whichever side is checking (the
// responder's node handling an incoming "/offer" computes it as
// `self.identity.hash + remote_identity.hash`; the requester, generating
// its own key ahead of time, computes it as `peer.identity.hash + router.
// identity.hash` — the same concatenation, just derived from each side's
// own perspective).
export function peering_key_material(responder_identity_hash, requester_identity_hash) {
    return crypto.concat(responder_identity_hash, requester_identity_hash);
}

export async function generate_peering_key(responder_identity_hash, requester_identity_hash, target_cost) {
    const material = peering_key_material(responder_identity_hash, requester_identity_hash);
    return generate_stamp(material, target_cost, WORKBLOCK_EXPAND_ROUNDS_PEERING);
}

export function validate_peering_key(responder_identity_hash, requester_identity_hash, peering_key, target_cost) {
    const material = peering_key_material(responder_identity_hash, requester_identity_hash);
    const workblock = stamp_workblock(material, WORKBLOCK_EXPAND_ROUNDS_PEERING);
    return stamp_valid(peering_key, target_cost, workblock);
}
