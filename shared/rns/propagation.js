// LXMF propagation nodes: store-and-forward for when the recipient isn't
// directly reachable. A sender hands an encrypted, addressed message to a
// propagation node (over a Link, as a Resource — see index.js's
// Link.sendResource()); the node stores it without being able to read it;
// the actual recipient later connects to the same node and syncs down
// anything addressed to them.
//
// This is a from-scratch design *inspired by* real LXMF's LXMRouter/LXMPeer
// (same core ideas: a dedicated "lxmf.propagation" destination, messages
// identified by a transient_id hash rather than a sequence number, a
// list-then-fetch client sync protocol under a "/get" request path,
// LXStamper's proof-of-work admission stamps, and — see syncToPeer() below —
// node-to-node peer sync under an "/offer" request path with its own
// peering-key stamps). What isn't wire-compatible: messages travel over this
// project's Resource implementation, which is itself JS-only-interoperable
// for anything past a single segment (see protocol.js's "RNS.Resource"
// section), and this project's own client-facing "/get" sync protocol
// (`syncLXMF()`) is a different, JS-only mechanism from real LXMF's — see
// `syncFromRealPropagationNode()` for the one that's wire-compatible. Real
// LXMF's message *envelope* (destination_hash + source_hash + signature +
// msgpack payload) is reused unchanged, wrapped in an extra layer that keeps
// the destination_hash in the clear (so a node can index by it) while
// encrypting the rest to the recipient's identity, so a storing node can
// never read message content.
//
// See README's Compliance section for exactly what this does and doesn't
// implement relative to real LXMF propagation nodes.
import { Destination, tryParseLxmf } from './index.js';
import * as protocol from './protocol.js';
import * as crypto from './crypto.js';
import * as msgpack from './msgpack.js';
import * as stamp from './stamp.js';

// destination_hash(16) + identity_encrypt(lxmf_wire_payload, recipient's
// identity/ratchet) — the destination hash stays unencrypted so a
// propagation node can index stored messages by recipient without being
// able to decrypt them.
export function build_propagated_envelope(destination_hash, lxmf_wire_payload, recipient_identity_pub, recipient_ratchet_pub) {
    return crypto.concat(destination_hash, protocol.identity_encrypt(lxmf_wire_payload, recipient_identity_pub, recipient_ratchet_pub));
}

// A message's identity in a propagation node's store — the full hash of its
// envelope, matching LXMF's own notion of a transient_id (a hash that
// identifies a specific propagated message without revealing its content).
export function propagated_transient_id(envelope) {
    return crypto.sha256(envelope);
}

// A propagation node: a dedicated "lxmf.propagation" destination that
// accepts store-and-forward uploads (as a Resource sent over an incoming
// Link — see the module comment above) and serves them back to whoever
// proves ownership of the addressed destination hash. Storage is in-memory
// only (lost on restart), with no size limit or expiry, matching this
// project's existing simplifications for identities/paths/links.
//
// stampCost sets the proof-of-work admission requirement (see stamp.js):
// each uploaded message must carry a trailing 32-byte stamp valid for at
// least this many leading zero bits, computed over its own transient_id.
// The default of 0 accepts any stamp (including an all-zero one), i.e. no
// real anti-spam requirement — real LXMF propagation nodes announce their
// required cost so senders know what to compute; that announce-parsing
// isn't implemented here, so a sender must be told the required cost out of
// band (see propagateLXMF's stampCost parameter).
//
// peeringCost sets the proof-of-work required of another propagation node
// before it's allowed to sync messages to this one (see syncToPeer() below
// and stamp.js's peering-key functions) — matches real LXMF's
// LXMRouter.peering_cost (default 18).
export class PropagationNode {
    constructor(rns, identity, { stampCost = 0, peeringCost = 18 } = {}) {
        this.rns = rns;
        this.identity = identity;
        this.stampCost = stampCost;
        this.peeringCost = peeringCost;
        this.destination = new Destination(rns, identity, Destination.IN, Destination.SINGLE, 'lxmf', 'propagation');
        this.messages = new Map(); // transient_id hex -> { destinationHash, envelope, stamp }
        this.peers = new Map(); // peer identity hash hex -> { peeringKey, handledMessages: Set<transient_id hex> }

        this.destination.registerRequestHandler('/get', (data, requestId, link) => this._onGetRequest(data, link));
        this.destination.registerRequestHandler('/offer', (data, requestId, link) => this._onOfferRequest(data, link));
        this.destination.on('link', (link) => {
            link.on('resource', (resourceData) => this._onUpload(resourceData));
        });
    }

    announce() {
        this.destination.announce();
    }

    _onUpload(resourceData) {
        let unpacked;
        try {
            unpacked = msgpack.unpack(resourceData);
        } catch {
            return;
        }
        if (!Array.isArray(unpacked) || unpacked.length < 2 || !Array.isArray(unpacked[1])) return;

        for (const entry of unpacked[1]) {
            if (!(entry instanceof Uint8Array) || entry.length <= 16 + stamp.STAMP_SIZE) continue;

            const envelope = entry.slice(0, -stamp.STAMP_SIZE);
            const stampBytes = entry.slice(-stamp.STAMP_SIZE);
            const transientId = propagated_transient_id(envelope);
            const workblock = stamp.stamp_workblock(transientId);
            if (!stamp.stamp_valid(stampBytes, this.stampCost, workblock)) continue;

            const key = crypto.bytesToHex(transientId);
            if (!this.messages.has(key)) {
                // The stamp is kept (not just the envelope): a client's own
                // "/get" download doesn't need it (see _onGetRequest, which
                // only ever serves `entry.envelope`), but forwarding this
                // message on to a peer during sync does — a real propagation
                // node re-validates a peer-forwarded message's original
                // stamp exactly like a fresh upload's, so it has to still be
                // attached (see syncToPeer() below).
                this.messages.set(key, { destinationHash: envelope.slice(0, 16), envelope, stamp: stampBytes });
            }
        }
    }

    // [wantList, haveList, sourceHash, proof]. sourceHash/proof authenticate
    // the requester as the owner of that destination hash (proof = their
    // real identity's Ed25519 signature over linkId+sourceHash) — without
    // this, anyone could enumerate or purge another destination's stored
    // messages, even though they still couldn't decrypt the contents.
    // wantList == null && haveList == null lists available messages instead
    // of fetching/purging any.
    _onGetRequest(data, link) {
        if (!Array.isArray(data) || data.length < 4) return null;
        const [wantList, haveList, sourceHash, proof] = data;
        if (!(sourceHash instanceof Uint8Array) || !(proof instanceof Uint8Array)) return null;

        const senderIdentity = this.rns.identities.get(crypto.bytesToHex(sourceHash));
        if (!senderIdentity) return null;

        const signedData = crypto.concat(link.linkId, sourceHash);
        if (!crypto.ed25519_validate(proof, signedData, senderIdentity.public_key.slice(32))) return null;

        const sourceHashHex = crypto.bytesToHex(sourceHash);

        if (wantList == null && haveList == null) {
            const available = [];
            for (const [key, entry] of this.messages.entries()) {
                if (crypto.bytesToHex(entry.destinationHash) === sourceHashHex) {
                    available.push([crypto.hexToBytes(key), entry.envelope.length]);
                }
            }
            return available;
        }

        // Fetch before purge: a caller is allowed to pass the same IDs in
        // both lists (this project's syncLXMF() does, to mean "fetch these,
        // then delete them since I've now got them") — purging first would
        // make them vanish before they could be looked up for the response.
        const response = [];
        if (Array.isArray(wantList)) {
            for (const transientId of wantList) {
                const entry = this.messages.get(crypto.bytesToHex(transientId));
                if (entry && crypto.bytesToHex(entry.destinationHash) === sourceHashHex) {
                    response.push(entry.envelope);
                }
            }
        }

        if (Array.isArray(haveList)) {
            for (const transientId of haveList) {
                const key = crypto.bytesToHex(transientId);
                const entry = this.messages.get(key);
                if (entry && crypto.bytesToHex(entry.destinationHash) === sourceHashHex) {
                    this.messages.delete(key);
                }
            }
        }

        return response;
    }

    // Node-to-node peer sync's offer step (matches real LXMF's
    // LXMPeer.OFFER_REQUEST_PATH "/offer" handler,
    // LXMRouter.offer_request()): `data = [peeringKey, transientIds]`. The
    // requester must have already proven their identity over this Link
    // (Link.identify()) — real RNS's request-dispatch machinery passes that
    // straight to the handler as a parameter; this project's Link exposes it
    // via getRemoteIdentity() instead, checked here directly. Returns:
    //  - 0xf0 (no identity presented) if the link was never identified
    //  - 0xf3 (invalid key) if the peering key doesn't meet peeringCost
    //  - false if we don't want any of the offered transient_ids
    //  - true if we want all of them
    //  - an array of the specific transient_ids we want, otherwise
    _onOfferRequest(data, link) {
        const remoteIdentity = link.getRemoteIdentity();
        if (!remoteIdentity) return 0xf0;

        if (!Array.isArray(data) || data.length < 2) return null;
        const [peeringKey, transientIds] = data;
        if (!(peeringKey instanceof Uint8Array) || !Array.isArray(transientIds)) return null;

        if (!stamp.validate_peering_key(this.identity.hash, remoteIdentity.hash, peeringKey, this.peeringCost)) {
            return 0xf3;
        }

        const wantedIds = transientIds.filter((id) => id instanceof Uint8Array && !this.messages.has(crypto.bytesToHex(id)));
        if (wantedIds.length === 0) return false;
        if (wantedIds.length === transientIds.length) return true;
        return wantedIds;
    }
}

// Sends an LXMF message via store-and-forward instead of directly: builds
// the same LXMF envelope Destination.sendLXMF() would (signed by `source`,
// your own IN destination), encrypts it to `destination`'s identity,
// computes an admission stamp (see stamp.js — target `stampCost` must match
// what the destination propagation node requires, since this implementation
// doesn't parse a node's announced cost automatically), and uploads it over
// an already-established Link. Returns the Link.sendResource() promise
// (resolves once the node acknowledges receipt of the transfer).
export async function propagateLXMF(propagationLink, destination, source, title, content, fields = {}, stampCost = 0) {
    if (destination.direction !== Destination.OUT) {
        throw new Error("Can only propagate LXMF to OUT destinations.");
    }
    if (!source || source.direction !== Destination.IN) {
        throw new Error("LXMF source must be your own IN destination.");
    }

    const knownIdentity = destination.rns.identities.get(crypto.bytesToHex(destination.hash));
    if (!knownIdentity) {
        throw new Error("Cannot propagate LXMF: destination identity not known.");
    }

    const wirePayload = protocol.lxmf_build(content, source.identity.private, destination.hash, source.hash, null, title, fields);
    const envelope = build_propagated_envelope(destination.hash, wirePayload, knownIdentity.public_key, knownIdentity.ratchet);
    const transientId = propagated_transient_id(envelope);
    const { stamp: stampBytes } = await stamp.generate_stamp(transientId, stampCost);
    const container = msgpack.pack([new msgpack.Float64(Date.now() / 1000), [crypto.concat(envelope, stampBytes)]]);

    return propagationLink.sendResource(container);
}

// Downloads and purges any messages a propagation node is holding for
// `source` (your own IN destination), over an already-established Link to
// that node. A two-round-trip list-then-fetch, purging each message from
// the node's store as it's retrieved — this implementation always
// downloads everything currently listed rather than tracking a separate
// "already seen" set across sessions. Resolves with an array of parsed LXMF
// messages (same shape as Destination's 'lxmf' event), skipping any
// envelope that fails to decrypt or whose signature doesn't validate.
export async function syncLXMF(propagationLink, source) {
    if (!source || source.direction !== Destination.IN) {
        throw new Error("LXMF sync source must be your own IN destination.");
    }

    const sourceHash = source.hash;
    const proof = crypto.ed25519_sign(source.identity.private.slice(32), crypto.concat(propagationLink.linkId, sourceHash));

    const listing = await propagationLink.request('/get', [null, null, sourceHash, proof]);
    if (!Array.isArray(listing) || listing.length === 0) return [];

    const wantList = listing.map(([transientId]) => transientId);
    const envelopes = await propagationLink.request('/get', [wantList, wantList, sourceHash, proof]);

    return _decryptEnvelopes(propagationLink.rns, envelopes, source);
}

// Shared by syncLXMF() and syncFromRealPropagationNode(): both fetch back an
// array of destination_hash(16) + identity_encrypt(...) envelopes and need
// the same decrypt-then-parse step; only how they *ask* for those envelopes
// (this project's own "/get" scheme vs. real LXMF's) differs.
function _decryptEnvelopes(rns, envelopes, source) {
    const messages = [];
    for (const envelope of envelopes) {
        if (!(envelope instanceof Uint8Array) || envelope.length <= 16) continue;
        const destinationHash = envelope.slice(0, 16);
        const cipherBlob = envelope.slice(16);

        const decrypted = protocol.message_decrypt({ data: cipherBlob }, source.identity.public, [source.identity.ratchetPrivate, source.identity.private.slice(0, 32)]);
        if (!decrypted) continue;

        const parsed = tryParseLxmf(rns, destinationHash, decrypted);
        if (parsed) messages.push(parsed);
    }
    return messages;
}

// Downloads and purges any messages a *real* LXMF.LXMRouter propagation node
// (enable_propagation()) is holding for `source` (your own IN lxmf/delivery
// destination — same convention as syncLXMF()), over an already-established
// Link to that node's real "lxmf.propagation" destination. Unlike syncLXMF()
// (this project's own JS-only scheme), a real node authenticates the
// requester via RNS.Link.identify() rather than a signature embedded in the
// request payload — proving `source.identity` is what tells the node which
// stored messages (filed by *their* recipient's delivery-destination hash)
// belong to us — and its "/get" response shapes differ slightly (see below).
// The stored envelope format itself turned out to be identical (confirmed
// via propagateLXMF() uploading to a real node — see README's Compliance
// section), so the same decrypt/parse step applies once the envelopes are
// back.
//
// Real RNS's LXMPeer.message_get_request():
//  - Listing (`data = [null, null]`) responds with a flat array of bare
//    transient_id hashes — not this project's own `[transientId, size]`
//    pairs.
//  - Fetching (`data = [want, have]`) responds with an array of raw
//    envelope bytes, the trailing admission stamp already stripped off.
// Both are matched here by requesting the exact same shapes — except a real
// node's request handler processes the "have" (purge) list *before* the
// "want" (fetch) list within a single request (found by testing against a
// live node: passing the same list as both, like this project's own
// PropagationNode intentionally supports, silently purges everything before
// it can be looked up to serve back — this project's own node was written
// to fetch first specifically to avoid this footgun, but a real node has
// the opposite order). So this fetches in one request, then purges what was
// retrieved in a separate, later one — matching how LXMRouter's own client
// code (message_list_response/message_get_response) does it.
export async function syncFromRealPropagationNode(propagationLink, source) {
    if (!source || source.direction !== Destination.IN) {
        throw new Error("LXMF sync source must be your own IN destination.");
    }

    propagationLink.identify(source.identity);

    const listing = await propagationLink.request('/get', [null, null]);
    if (!Array.isArray(listing) || listing.length === 0) return [];

    const envelopes = await propagationLink.request('/get', [listing, null]);
    const messages = _decryptEnvelopes(propagationLink.rns, envelopes, source);

    await propagationLink.request('/get', [null, listing]).catch(() => {});

    return messages;
}

// --- Node-to-node peer sync (LXMPeer's "/offer" protocol) ---
// Offers `node`'s stored messages to another propagation node (a peer) over
// an already-established Link to their "lxmf.propagation" destination,
// uploading whichever ones the peer doesn't already have. Mirrors real
// LXMF's LXMPeer.sync()/offer_response()/resource_concluded() at the wire
// level — the "/offer" request path, a peering-key stamp proving proof-of-
// work for this specific (peer, us) relationship (see stamp.js), and a
// Resource-based transfer of wanted messages, complete with their original
// admission stamps still attached (a real node re-validates a peer-
// forwarded message's stamp exactly like a fresh upload's, so removing it
// the way a client-facing "/get" download does would break re-validation
// three hops later) — without real LXMF's automatic background scheduling,
// retry backoff, or transfer-rate tracking: this is one explicit sync
// attempt, not a standing peer relationship that syncs itself over time.
//
// peeringCost must match what the peer actually requires (its own
// LXMRouter.peering_cost/PropagationNode.peeringCost) — like propagateLXMF's
// stampCost, this isn't learned automatically from an announce, so it has
// to be supplied by the caller. The peering key is generated once per
// `node` (cached on first sync) and on real LXMF, at the default cost of
// 18, expect this to take several seconds — see stamp.js's module comment
// on why there's no parallel search to speed it up.
export async function syncToPeer(node, peerLink, peerIdentity, { peeringCost = 18 } = {}) {
    peerLink.identify(node.identity);

    const peerHashHex = crypto.bytesToHex(peerIdentity.hash);
    let peerState = node.peers.get(peerHashHex);
    if (!peerState) {
        peerState = { peeringKey: null, handledMessages: new Set() };
        node.peers.set(peerHashHex, peerState);
    }
    if (!peerState.peeringKey) {
        const { stamp: peeringKey } = await stamp.generate_peering_key(peerIdentity.hash, node.identity.hash, peeringCost);
        peerState.peeringKey = peeringKey;
    }

    const unhandled = [];
    for (const key of node.messages.keys()) {
        if (!peerState.handledMessages.has(key)) unhandled.push(key);
    }
    if (unhandled.length === 0) return { offered: 0, synced: 0 };

    // A longer timeout than the request() default: the peer must validate our
    // peering key by recomputing its stamp workblock, which (like generating
    // one) is a deliberately expensive hashcash-style computation.
    const response = await peerLink.request('/offer', [peerState.peeringKey, unhandled.map((key) => crypto.hexToBytes(key))], { timeout: 30000 });

    if (response === 0xf0) throw new Error('Peer indicated no identity was received');
    if (response === 0xf1) throw new Error('Peer denied access');
    if (response === 0xf3) {
        peerState.peeringKey = null; // cost may have changed; regenerate next time
        throw new Error('Peer rejected our peering key (insufficient cost)');
    }

    let wanted;
    if (response === false) wanted = [];
    else if (response === true) wanted = unhandled;
    else if (Array.isArray(response)) wanted = response.map((id) => crypto.bytesToHex(id));
    else throw new Error('Unexpected /offer response');

    const wantedSet = new Set(wanted);
    for (const key of unhandled) {
        if (!wantedSet.has(key)) peerState.handledMessages.add(key); // peer already has it via another path
    }

    if (wanted.length > 0) {
        const envelopes = wanted
            .map((key) => node.messages.get(key))
            .filter(Boolean)
            .map((entry) => crypto.concat(entry.envelope, entry.stamp));
        const container = msgpack.pack([new msgpack.Float64(Date.now() / 1000), envelopes]);
        await peerLink.sendResource(container);
        for (const key of wanted) peerState.handledMessages.add(key);
    }

    return { offered: unhandled.length, synced: wanted.length };
}
