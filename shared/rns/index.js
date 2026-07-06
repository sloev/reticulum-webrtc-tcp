import * as protocol from './protocol.js';
import { EventEmitter } from 'events';
import * as crypto from './crypto.js';
import { pack, unpack } from 'msgpackr';
import { Channel } from './channel.js';
import * as compression from './compression.js';

export class Reticulum extends EventEmitter {
    constructor() {
        super();
        this.interfaces = [];
        this.destinations = new Map(); // hash hex -> Destination
        this.links = new Map(); // hash hex -> Link

        // Cache to store known public keys and ratchets from announcements
        this.identities = new Map(); // hash hex -> { public_key, ratchet, app_data }

        // Lowest hop count seen to each destination, for answering path
        // requests and for single-destination forwarding (see _forward()).
        // Scoped to single-hop-aware flood propagation for announces, plus
        // simple next-hop forwarding for single-destination DATA/PROOF
        // packets — not full RNS.Transport routing (see protocol.js's
        // Transport section and README's Compliance section).
        this.pathTable = new Map(); // hash hex -> { hops, receivingInterface, fromPeerId, packet, timestamp }

        // Per-link routing table for relaying a Link handshake (and
        // everything that flows over it afterward) through an intermediate
        // peer that owns neither endpoint — a link_id can't use pathTable
        // since it isn't a real, announced destination. See
        // _forwardLinkRequest()/_forwardLinkTraffic().
        this.linkTable = new Map(); // link_id hex -> { ifaceA, peerA, ifaceB, peerB }

        // Pending Destination.send({ requestProof: true }) calls awaiting a
        // delivery proof, keyed by the proof's own destination_hash (the
        // first 16 bytes of the original packet's full hash — see
        // protocol.js's "RNS.Packet delivery proofs" section).
        this.pendingProofs = new Map(); // hash hex -> { packetFullHash, destinationIdentityPub, resolve, timer }

        // A persistent per-instance identity, matching RNS.Transport.identity
        // — its hash is sent in outgoing path requests (see requestPath()).
        // In-memory only, like the rest of this project's state (see
        // README's Compliance / Known limitations sections).
        this.transportIdentity = Identity.create();

        // Last time (Date.now()) a path request was sent for a destination,
        // matching RNS.Transport.path_requests — used to throttle repeated
        // requestPath() calls per RNS.Transport.PATH_REQUEST_MI.
        this.pathRequestTimestamps = new Map(); // hash hex -> timestamp

        // Per-destination announce timestamps, matching RNS.Transport's
        // announce rate table (capped at MAX_RATE_TIMESTAMPS entries per
        // destination). Recorded on every announce for parity, but nothing
        // currently enforces a rate limit from it — real RNS only rejects
        // announces once a per-interface `announce_rate_target` is
        // configured, which defaults to off, same as here.
        this.announceRateTable = new Map(); // hash hex -> timestamp[]

        // Matches RNS.Transport.DESTINATION_TIMEOUT: periodically drops path
        // table entries that haven't been refreshed in a week, so a long-
        // running peer's path table doesn't grow unbounded with stale routes.
        this._pathCleanupTimer = setInterval(() => this._cleanupPathTable(), 60 * 60 * 1000);
        if (typeof this._pathCleanupTimer.unref === 'function') this._pathCleanupTimer.unref();
    }

    // Drops path table entries not refreshed within DESTINATION_TIMEOUT_MS —
    // split out from the constructor's setInterval so a test can call it
    // directly instead of waiting a week.
    _cleanupPathTable() {
        const cutoff = Date.now() - protocol.DESTINATION_TIMEOUT_MS;
        for (const [hex, entry] of this.pathTable) {
            if (entry.timestamp < cutoff) this.pathTable.delete(hex);
        }
    }

    addInterface(iface) {
        iface.rns = this;
        this.interfaces.push(iface);
        iface.connect();
    }

    sendData(data) {
        for (const iface of this.interfaces) {
            iface.sendData(data);
        }
    }

    // fromPeerId identifies which neighbor on receivingInterface a packet
    // arrived from (e.g. a specific WebRTC peer connection or TCP socket),
    // when that interface has more than one; null for interfaces that don't
    // distinguish neighbors.
    onPacketReceived(data, receivingInterface, fromPeerId = null) {
        try {
            if ((data[0] & 0x80) === 0x80) {
               this._broadcastExcept(data, receivingInterface, fromPeerId);
               return;
            }

            const packet = protocol.packet_unpack(data);
            if (!packet) return;

            // Matches RNS.Transport.inbound(): every packet gains one hop
            // upon receipt, whether or not we do anything with that count.
            packet.hops = (packet.hops + 1) & 0xff;
            const forwarded = new Uint8Array(data);
            forwarded[1] = packet.hops;

            const destHex = crypto.bytesToHex(packet.destination_hash);
            const destination = this.destinations.get(destHex);

            if (packet.packet_type === protocol.PACKET_ANNOUNCE) {
                const announce = protocol.validate_announce(packet);
                if (announce) {
                    this.identities.set(destHex, {
                        public_key: announce.public_key,
                        ratchet: announce.ratchet,
                        app_data: announce.app_data
                    });

                    const existing = this.pathTable.get(destHex);
                    if (!existing || packet.hops <= existing.hops) {
                        this.pathTable.set(destHex, { hops: packet.hops, receivingInterface, fromPeerId, packet: forwarded, timestamp: Date.now() });
                    }

                    const rateEntry = this.announceRateTable.get(destHex) || [];
                    rateEntry.push(Date.now());
                    while (rateEntry.length > protocol.MAX_RATE_TIMESTAMPS) rateEntry.shift();
                    this.announceRateTable.set(destHex, rateEntry);

                    this.emit('announce', { ...announce, destination_hash: packet.destination_hash });
                    // Rebroadcast to every other neighbor (whether on this
                    // same interface or a different one), with the
                    // incremented hop count.
                    this._broadcastExcept(forwarded, receivingInterface, fromPeerId);
                }
            } else if (packet.packet_type === protocol.PACKET_LINKREQUEST) {
                if (destination) {
                    destination.onLinkRequest(packet, data);
                } else {
                    this._forwardLinkRequest(packet, data, receivingInterface, fromPeerId, forwarded);
                }
            } else if (packet.packet_type === protocol.PACKET_DATA) {
                if (packet.destination_type === protocol.DEST_LINK) {
                    const link = this.links.get(destHex);
                    if (link) {
                        link.onPacket(packet, data);
                    } else {
                        this._forwardLinkTraffic(destHex, receivingInterface, fromPeerId, forwarded, packet.context === protocol.CONTEXT_LINKCLOSE);
                    }
                } else if (packet.destination_type === protocol.DEST_PLAIN && destHex === crypto.bytesToHex(protocol.PATH_REQUEST_DEST_HASH)) {
                    this._handlePathRequest(packet);
                } else if (destination) {
                    destination.onData(packet, data);
                } else {
                    this._forward(destHex, receivingInterface, fromPeerId, forwarded);
                }
            } else if (packet.packet_type === protocol.PACKET_PROOF) {
                if (packet.destination_type === protocol.DEST_LINK) {
                    const link = this.links.get(destHex);
                    if (link) {
                        link.onProof(packet);
                    } else {
                        this._forwardLinkTraffic(destHex, receivingInterface, fromPeerId, forwarded, false);
                    }
                } else if (this.pendingProofs.has(destHex)) {
                    this._handlePacketProof(destHex, packet);
                } else if (destination) {
                    destination.onProof(packet);
                } else {
                    this._forward(destHex, receivingInterface, fromPeerId, forwarded);
                }
            }
        } catch (e) {
            console.error("Error processing packet:", e);
        }
    }

    // Floods data to every neighbor except the one it just arrived from —
    // whether that neighbor is on a different Interface entirely, or is
    // another peer on the same multi-peer interface (e.g. two WebRTC
    // connections on one browser peer relaying between each other).
    _broadcastExcept(data, receivingInterface, fromPeerId) {
        for (const iface of this.interfaces) {
            if (iface === receivingInterface) {
                iface.sendDataExcluding(fromPeerId, data);
            } else {
                iface.sendData(data);
            }
        }
    }

    // Forwards a DATA/PROOF packet addressed to a single destination that
    // isn't local, toward the next hop recorded in the path table (learned
    // from that destination's announces) — a simplified, single-destination-
    // only analog of RNS.Transport's hop-by-hop packet routing. Does nothing
    // if the destination is unknown, or if forwarding would just echo the
    // packet back to whoever just sent it to us.
    _forward(destHex, receivingInterface, fromPeerId, forwardedData) {
        const path = this.pathTable.get(destHex);
        if (!path) return;
        if (path.receivingInterface === receivingInterface && path.fromPeerId === fromPeerId) return;
        path.receivingInterface.sendDataToPeer(path.fromPeerId, forwardedData);
    }

    // Lets a Link handshake pass through an intermediate peer that owns
    // neither endpoint, using the same path-table-based next-hop lookup as
    // _forward() above. Remembers, keyed by link_id (computed the same way
    // both endpoints will, without needing to decrypt anything), which two
    // neighbors this LINKREQUEST is being relayed between — since a link_id
    // isn't a real, announced destination, later link traffic (the PROOF,
    // and everything that flows over the link afterward) has no path-table
    // entry to look up and needs this dedicated table instead.
    _forwardLinkRequest(packet, rawData, receivingInterface, fromPeerId, forwardedData) {
        const destHex = crypto.bytesToHex(packet.destination_hash);
        const path = this.pathTable.get(destHex);
        if (!path) return;
        if (path.receivingInterface === receivingInterface && path.fromPeerId === fromPeerId) return;

        const linkId = protocol.link_id_from_request(rawData, packet.data.length);
        this.linkTable.set(crypto.bytesToHex(linkId), {
            ifaceA: receivingInterface, peerA: fromPeerId,
            ifaceB: path.receivingInterface, peerB: path.fromPeerId,
        });

        path.receivingInterface.sendDataToPeer(path.fromPeerId, forwardedData);
    }

    // Relays a PROOF, or any later DATA packet addressed to an established
    // link (application data, Request/Response, KEEPALIVE, LINKCLOSE), for a
    // link_id this node is relaying but is neither endpoint of — routing it
    // to whichever of the two remembered neighbors it *didn't* just arrive
    // from. Cleans up the table entry once a LINKCLOSE has passed through.
    _forwardLinkTraffic(linkIdHex, receivingInterface, fromPeerId, forwardedData, isClose) {
        const entry = this.linkTable.get(linkIdHex);
        if (!entry) return;

        if (entry.ifaceA === receivingInterface && entry.peerA === fromPeerId) {
            entry.ifaceB.sendDataToPeer(entry.peerB, forwardedData);
        } else if (entry.ifaceB === receivingInterface && entry.peerB === fromPeerId) {
            entry.ifaceA.sendDataToPeer(entry.peerA, forwardedData);
        } else {
            return;
        }

        if (isClose) this.linkTable.delete(linkIdHex);
    }

    // Resolves a pending Destination.send({ requestProof: true }) once a
    // valid delivery proof for it arrives (see protocol.js's "RNS.Packet
    // delivery proofs" section) — a no-op if the signature doesn't check
    // out against the destination identity the sender already knew.
    _handlePacketProof(proofDestHex, packet) {
        const pending = this.pendingProofs.get(proofDestHex);
        if (!pending) return;
        if (!protocol.validate_packet_proof(packet, pending.packetFullHash, pending.destinationIdentityPub)) return;

        clearTimeout(pending.timer);
        this.pendingProofs.delete(proofDestHex);
        pending.resolve({ packetFullHash: pending.packetFullHash });
    }

    // Answers a path request either with a fresh, locally-signed announce
    // (if we own the requested destination) or by re-broadcasting the best
    // cached announce we know of (if we've merely heard of it) — matching
    // RNS.Transport.path_request(), minus its interface-timing/roaming-mode
    // rebroadcast delays, which don't apply to this project's WebRTC mesh.
    _handlePathRequest(packet) {
        const parsed = protocol.parse_path_request(packet);
        if (!parsed) return;
        const destHex = crypto.bytesToHex(parsed.destination_hash);

        const localDestination = this.destinations.get(destHex);
        if (localDestination) {
            localDestination.announce({ pathResponse: true });
            return;
        }

        const known = this.pathTable.get(destHex);
        if (known) this.sendData(known.packet);
    }

    // Broadcasts a path request for a destination hash, matching
    // RNS.Transport.request_path()'s 3-field (transport-enabled) form and
    // its PATH_REQUEST_MI throttle: a repeat request for the same
    // destination within PATH_REQUEST_MI_MS of the last one is suppressed.
    requestPath(destination_hash, tag = crypto.randomBytes(16)) {
        const destHex = crypto.bytesToHex(destination_hash);
        const last = this.pathRequestTimestamps.get(destHex) || 0;
        if (Date.now() - last < protocol.PATH_REQUEST_MI_MS) return;
        this.pathRequestTimestamps.set(destHex, Date.now());
        this.sendData(protocol.build_path_request(destination_hash, tag, this.transportIdentity.hash));
    }
}

export class Identity {
    constructor(privateBytes = null) {
        this.private = privateBytes || crypto.private_identity();
        this.public = crypto.public_identity(this.private);
        this.ratchetPrivate = crypto.private_ratchet();
        this.ratchetPublic = crypto.public_ratchet(this.ratchetPrivate);
        // Matches RNS.Identity.hash: sha256(public_key)[:16]. Used to derive
        // destination hashes and as the HKDF salt for single-destination
        // encryption (see protocol.identity_hash).
        this.hash = protocol.identity_hash(this.public);
    }
    static create() {
        return new Identity();
    }
}

// Shared by Destination.onData() (opportunistic delivery) and
// shared/rns/propagation.js's sync (propagated delivery): an LXMF payload
// embeds its own sender's destination hash as its first 16 bytes; look up
// that specific identity (learned from an earlier announce) rather than
// brute-forcing every known identity, and require a *valid* signature
// against it before treating the payload as LXMF. Returns the parsed
// message, or null if it isn't a validly-signed LXMF payload from a known
// sender.
export function tryParseLxmf(rns, destination_hash, decrypted) {
    if (decrypted.length < 16) return null;
    const senderIdentity = rns.identities.get(crypto.bytesToHex(decrypted.slice(0, 16)));
    if (!senderIdentity) return null;

    const parsed = protocol.lxmf_parse(decrypted, destination_hash, senderIdentity.public_key);
    return (parsed && parsed.valid) ? parsed : null;
}

// Same idea as tryParseLxmf() above, but for LXMF's DIRECT delivery form
// (arriving as a Link's plain application-data packet or a completed generic
// Resource — see Link.onPacket()/_assembleResource()) — the destination hash
// isn't passed in separately since DIRECT's wire form carries its own (see
// protocol.lxmf_build_direct/lxmf_parse_direct).
export function tryParseLxmfDirect(rns, decrypted) {
    if (decrypted.length < 32) return null;
    const senderIdentity = rns.identities.get(crypto.bytesToHex(decrypted.slice(16, 32)));
    if (!senderIdentity) return null;

    const parsed = protocol.lxmf_parse_direct(decrypted, senderIdentity.public_key);
    return (parsed && parsed.valid) ? parsed : null;
}

export class Destination extends EventEmitter {
    static IN = 0;
    static OUT = 1;
    static SINGLE = protocol.DEST_SINGLE;
    static LINK = protocol.DEST_LINK;

    constructor(rns, identity, direction, type, appName, ...aspects) {
        super();
        this.rns = rns;
        this.identity = identity;
        this.direction = direction;
        this.type = type;
        this.fullName = [appName, ...aspects].join('.');

        if (identity && identity.public) {
             this.hash = protocol.get_identity_destination_hash(identity.public, this.fullName);
        } else {
             this.hash = new Uint8Array(16);
        }

        if (this.direction === Destination.IN) {
            this.rns.destinations.set(crypto.bytesToHex(this.hash), this);
        }
    }

    // requestProof: true asks for a delivery confirmation (RNS.Packet.prove()/
    // PacketReceipt, implicit form only — see protocol.js's "RNS.Packet
    // delivery proofs" section). Returns a Promise resolving once a valid
    // proof is seen, or rejecting on timeout; without requestProof, returns
    // undefined immediately, matching a fire-and-forget send.
    send(data, { requestProof = false, timeout = 10000 } = {}) {
        if (this.direction !== Destination.OUT) {
            throw new Error("Can only send to OUT destinations directly without a Link.");
        }

        const knownIdentity = this.rns.identities.get(crypto.bytesToHex(this.hash));
        if (!knownIdentity) {
            console.error("Cannot send data: Destination identity/ratchet not known. Waiting for announce.");
            return requestProof ? Promise.reject(new Error("Destination identity/ratchet not known.")) : undefined;
        }

        const dataPacket = protocol.build_data(data, knownIdentity.public_key, knownIdentity.ratchet, this.fullName);
        this.rns.sendData(dataPacket);

        if (!requestProof) return;

        const fullHash = protocol.packet_full_hash(dataPacket);
        const proofDestHex = crypto.bytesToHex(fullHash.slice(0, 16));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.rns.pendingProofs.delete(proofDestHex);
                reject(new Error("Packet was not proven within timeout."));
            }, timeout);
            this.rns.pendingProofs.set(proofDestHex, {
                packetFullHash: fullHash,
                destinationIdentityPub: knownIdentity.public_key,
                resolve, timer,
            });
        });
    }

    // Sends an LXMF message to this (OUT) destination, signed by `source` —
    // your own local (IN) destination, since `this.identity` on an OUT
    // destination is the *recipient's* identity (used to encrypt to them),
    // not yours. Matches LXMF's OPPORTUNISTIC delivery method: a single
    // packet, opportunistically encrypted exactly like a normal DATA packet
    // (see protocol.js's "LXMF" section for the wire format and README's
    // Compliance section for what's not implemented, e.g. propagation nodes
    // and Resource-based transfer for oversized messages).
    sendLXMF(source, title, content, fields = {}) {
        if (this.direction !== Destination.OUT) {
            throw new Error("Can only send LXMF to OUT destinations.");
        }
        if (!source || source.direction !== Destination.IN) {
            throw new Error("LXMF source must be your own IN destination.");
        }

        const knownIdentity = this.rns.identities.get(crypto.bytesToHex(this.hash));
        if (!knownIdentity) {
            console.error("Cannot send LXMF: Destination identity not known.");
            return;
        }

        const lxmfMsg = protocol.lxmf_build(content, source.identity.private, this.hash, source.hash, null, title, fields);
        const dataPacket = protocol.build_data(lxmfMsg, knownIdentity.public_key, knownIdentity.ratchet, this.fullName);
        this.rns.sendData(dataPacket);
    }

    onData(packet, rawBytes) {
        if (this.direction === Destination.OUT) return;

        // Try the destination's current ratchet first, then fall back to the
        // identity's own X25519 key, matching RNS.Identity.decrypt()'s fallback
        // for senders who didn't have (or use) an announced ratchet.
        const decrypted = protocol.message_decrypt(packet, this.identity.public, [this.identity.ratchetPrivate, this.identity.private.slice(0, 32)]);
        if (decrypted) {
            const parsedLxmf = tryParseLxmf(this.rns, this.hash, decrypted);

            if (parsedLxmf) {
                this.emit('lxmf', parsedLxmf);
            } else {
                // Sends an explicit delivery confirmation back to whoever
                // sent this packet (RNS.Packet.prove(), implicit form) — opt-
                // in, since not every packet a destination receives needs
                // (or should get) a proof sent back.
                const prove = () => {
                    const proofPacket = protocol.build_packet_proof(protocol.packet_full_hash(rawBytes), this.identity.private);
                    this.rns.sendData(proofPacket);
                };
                this.emit('packet', { data: decrypted, packet, prove });
            }
        }
    }

    onLinkRequest(packet, rawBytes) {
        const link = Link.fromRequest(this.rns, this, packet, rawBytes);
        if (link) this.emit('link', link);
    }

    // Registers a handler for requests made over any Link to this
    // destination, matching RNS.Destination.register_request_handler() in
    // its simplest form: handler(data, requestId, link) is called
    // synchronously and its return value (if not undefined) is sent back as
    // the response. Unlike RNS, there's no allow-list/identity-based access
    // control or async/file-response support.
    registerRequestHandler(path, handler) {
        if (!this.requestHandlers) this.requestHandlers = new Map();
        this.requestHandlers.set(crypto.bytesToHex(protocol.request_path_hash(path)), { path, handler });
    }

    onProof(packet) {
        this.emit('proof', packet);
    }

    announce({ pathResponse = false } = {}) {
        if (this.identity) {
            const context = pathResponse ? protocol.CONTEXT_PATH_RESPONSE : protocol.CONTEXT_NONE;
            const packet = protocol.build_announce(
                this.identity.private, this.identity.public, this.hash,
                this.identity.ratchetPrivate, this.identity.ratchetPublic, this.fullName,
                new Uint8Array(0), context
            );
            this.rns.sendData(packet);
        }
    }
}

// Wire-compatible with RNS.Link's core handshake (LINKREQUEST -> PROOF ->
// LRRTT), per-link Token encryption, KEEPALIVE, and LINKCLOSE — verified
// byte-for-byte against the real `rns` package (see protocol.js's "RNS.Link
// wire format" section and test/rns-compliance.test.js). Also implements
// RNS.Link's real RTT-adaptive keepalive/stale/timeout state machine (see
// _watchdogTick()/_updateKeepalive() below), Resource transfers (including
// multi-segment, but not yet the rate-adaptive window or outgoing
// compression — see compliance.md), and Channel/Buffer.
//
// Request/Response is implemented for the direct-packet (fits-in-one-packet)
// form only — no Resource fallback yet for an oversized request/response
// (see compliance.md Phase 3). See README's Compliance section and
// compliance.md for the full parity checklist.
export class Link extends EventEmitter {
    static PENDING = 0;
    static HANDSHAKE = 1;
    static ACTIVE = 2;
    static STALE = 3;
    static CLOSED = 4;

    static TIMEOUT = 1; // teardown reason, matches RNS.Link.TIMEOUT
    static INITIATOR_CLOSED = 2;
    static DESTINATION_CLOSED = 3;

    static DEFAULT_MTU = 500;

    // RNS.Link's real RTT-adaptive keepalive/stale/timeout state machine
    // (RNS/Link.py), replacing the fixed intervals this used to use — see
    // _updateKeepalive()/_watchdogTick() below. Values match the Python
    // constants (seconds); converted to ms at the point of use.
    static DEFAULT_PER_HOP_TIMEOUT = 6;
    static ESTABLISHMENT_TIMEOUT_PER_HOP = 6;
    static KEEPALIVE_MAX = 360;
    static KEEPALIVE_MIN = 5;
    static KEEPALIVE_MAX_RTT = 1.75;
    static STALE_FACTOR = 2;
    static STALE_GRACE = 5;
    static KEEPALIVE_TIMEOUT_FACTOR = 4;

    // Use Link.fromRequest() to construct a responder-side link from an
    // incoming LINKREQUEST packet; use `new Link(rns, destination)` directly
    // to initiate one.
    constructor(rns, destination) {
        super();
        this.rns = rns;
        this.destination = destination;
        this.status = Link.PENDING;
        this.mtu = Link.DEFAULT_MTU;
        this.derivedKey = null;
        this._watchdogTimer = null;
        this.lastInbound = 0;
        this.lastKeepaliveSent = 0;
        this.activatedAt = null;
        this.keepaliveMs = Link.KEEPALIVE_MAX * 1000;
        this.staleTimeMs = this.keepaliveMs * Link.STALE_FACTOR;
        this.pendingRequests = new Map(); // request_id hex -> { resolve, reject, timer }
        this._outgoingResources = new Map(); // resource_hash hex -> { parts, hashmapEntries, expectedProof, resolve, reject, timer }
        this._incomingResources = new Map(); // resource_hash hex -> { randomHash, hashmapEntries, parts, receivedCount }
        this._resourceSegments = new Map(); // original_hash hex -> { chunks, totalSegments } — multi-segment reassembly
        this._channel = null; // lazily created by getChannel()
        this._remoteIdentity = null; // set once identify() is proven (initiator's identity, seen by a responder)

        this.initiator = true;
        this.xPrivate = crypto.private_ratchet();
        this.xPublic = crypto.x25519_pubkey(this.xPrivate);
        // Fresh ephemeral signing key per link, unlinkable to the initiator's
        // real identity (matches RNS.Link generating a throwaway Ed25519 key
        // instead of reusing owner.identity.sig_prv, which only the
        // *responder* side does).
        this.sigPrivate = crypto.randomBytes(32);
        this.sigPublic = crypto.ed25519_pubkey(this.sigPrivate);

        const requestRaw = protocol.build_link_request(destination.hash, this.xPublic, this.sigPublic, this.mtu);
        const unpacked = protocol.packet_unpack(requestRaw);
        this.linkId = protocol.link_id_from_request(requestRaw, unpacked.data.length);
        this.hash = this.linkId;

        // Matches RNS.Link's initiator-side establishment timeout (a base
        // per-hop timeout plus ESTABLISHMENT_TIMEOUT_PER_HOP per hop to the
        // destination). Real RNS asks the transport layer for a
        // link-specific first-hop timeout derived from the first
        // interface's bitrate; this project's transports (WebRTC/TCP) are
        // fast and don't vary that way, so DEFAULT_PER_HOP_TIMEOUT is used
        // as that base instead. Hops default to 1 if not yet known from the
        // path table (real RNS falls back to PATHFINDER_M/128 there, but a
        // Link is only ever constructed here once a path is already known).
        const destHex = crypto.bytesToHex(destination.hash);
        const knownHops = this.rns.pathTable.get(destHex)?.hops;
        const hops = Math.max(1, knownHops ?? 1);
        this.establishmentTimeoutMs = (Link.DEFAULT_PER_HOP_TIMEOUT + Link.ESTABLISHMENT_TIMEOUT_PER_HOP * hops) * 1000;

        this.rns.links.set(crypto.bytesToHex(this.linkId), this);
        this.requestTime = Date.now();
        this.rns.sendData(requestRaw);
        this._scheduleWatchdog(this.establishmentTimeoutMs);
    }

    static fromRequest(rns, destination, packet, rawBytes) {
        const parsed = protocol.parse_link_request(packet);
        if (!parsed) return null;

        const link = Object.create(Link.prototype);
        EventEmitter.call(link);
        link.rns = rns;
        link.destination = destination;
        link.status = Link.HANDSHAKE;
        link.initiator = false;
        link.mtu = parsed.mtu || Link.DEFAULT_MTU;
        link._watchdogTimer = null;
        link.lastInbound = 0;
        link.lastKeepaliveSent = 0;
        link.activatedAt = null;
        link.keepaliveMs = Link.KEEPALIVE_MAX * 1000;
        link.staleTimeMs = link.keepaliveMs * Link.STALE_FACTOR;
        link.pendingRequests = new Map();
        link._outgoingResources = new Map();
        link._incomingResources = new Map();
        link._resourceSegments = new Map();
        link._channel = null;
        link._remoteIdentity = null;

        link.peerXPublic = parsed.peer_x_pub;
        link.peerSigPublic = parsed.peer_sig_pub;

        link.xPrivate = crypto.private_ratchet();
        link.xPublic = crypto.x25519_pubkey(link.xPrivate);
        // Reuse the destination identity's real signing key, matching
        // RNS.Link (self.sig_prv = self.owner.identity.sig_prv for a
        // responder) — the destination's identity is already public via
        // its announces, so there's no anonymity to preserve here.
        link.sigPrivate = destination.identity.private.slice(32);
        link.sigPublic = crypto.ed25519_pubkey(link.sigPrivate);

        link.linkId = protocol.link_id_from_request(rawBytes, packet.data.length);
        link.hash = link.linkId;
        link.derivedKey = protocol.link_handshake(link.xPrivate, link.peerXPublic, link.linkId);

        link.rns.links.set(crypto.bytesToHex(link.linkId), link);
        link.requestTime = Date.now();
        // Matches RNS.Link's responder-side establishment timeout
        // (Link.validate_request): generous, since the responder must
        // tolerate however long it takes the initiator to receive our
        // PROOF and reply with LRRTT, over however many hops the request
        // itself travelled to get here.
        link.establishmentTimeoutMs = (Link.ESTABLISHMENT_TIMEOUT_PER_HOP * Math.max(1, packet.hops || 0) + Link.KEEPALIVE_MAX) * 1000;

        const proofRaw = protocol.build_link_proof(link.linkId, destination.identity.private, link.xPublic, link.mtu);
        link.rns.sendData(proofRaw);
        link._scheduleWatchdog(link.establishmentTimeoutMs);

        return link;
    }

    // Initiator-side: called when a PROOF (context=LRPROOF) packet addressed
    // to this link arrives. Also handles RESOURCE_PRF (a Resource transfer's
    // completion proof — see sendResource()/_onResourceProof below), which
    // can arrive on either side of the link, at any point after it's ACTIVE,
    // unlike the handshake's LRPROOF.
    onProof(packet) {
        this._noteInbound();

        if (packet.context === protocol.CONTEXT_RESOURCE_PRF) {
            this._onResourceProof(packet.data);
            return;
        }

        // Explicit Channel packet delivery proof (context NONE, packet_type
        // PROOF) — real RNS's only user of RNS.Packet.prove()/Link.
        // prove_packet(). Only possible once ACTIVE and only meaningful if a
        // Channel has actually been opened on this link.
        if (this.status === Link.ACTIVE && this._channel && packet.context === protocol.CONTEXT_NONE) {
            if (this._channel._onPacketProof(packet)) return;
        }

        if (this.status !== Link.PENDING || !this.initiator) return;

        const validated = protocol.validate_link_proof(packet, this.linkId, this.destination.identity.public.slice(32));
        if (!validated) return;

        this.peerXPublic = validated.peer_x_pub;
        this.mtu = validated.mtu || this.mtu;
        this.derivedKey = protocol.link_handshake(this.xPrivate, this.peerXPublic, this.linkId);
        this.rtt = (Date.now() - this.requestTime) / 1000;
        this.status = Link.ACTIVE;

        let rttData = pack(this.rtt);
        if (!(rttData instanceof Uint8Array)) rttData = new Uint8Array(rttData);
        const rttPacket = protocol.build_link_packet(this.linkId, this.derivedKey, rttData, protocol.CONTEXT_LRRTT);
        this.rns.sendData(rttPacket);

        this._activateWatchdog();
        this.emit('established', this);
    }

    // Dispatches an incoming DATA packet addressed to this link by context:
    // application data (NONE), the initiator's RTT report (LRRTT),
    // KEEPALIVE ping/pong, LINKCLOSE teardown, a REQUEST/RESPONSE, or a
    // Resource transfer's advertisement/part/request. `rawBytes` is needed
    // (only for REQUEST) to compute the request_id.
    onPacket(packet, rawBytes) {
        if (this.status === Link.CLOSED) return;
        this._noteInbound();

        if (packet.context === protocol.CONTEXT_KEEPALIVE) {
            if (!this.initiator && packet.data.length === 1 && packet.data[0] === 0xff) {
                this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, new Uint8Array([0xfe]), protocol.CONTEXT_KEEPALIVE));
            }
            return;
        }

        // Resource part packets carry a raw ciphertext slice, not further
        // encrypted at the packet level (the whole blob was already
        // encrypted once in resource_prepare()) — see protocol.js's
        // "RNS.Resource" section.
        if (packet.context === protocol.CONTEXT_RESOURCE) {
            this._onResourcePart(packet.data);
            return;
        }

        if (!this.derivedKey) return;
        const plaintext = protocol.link_decrypt(this.derivedKey, packet.data);
        if (plaintext === null) return;

        if (packet.context === protocol.CONTEXT_RESOURCE_ADV) {
            this._onResourceAdvertisement(plaintext);
        } else if (packet.context === protocol.CONTEXT_RESOURCE_REQ) {
            this._onResourceRequest(plaintext);
        } else if (packet.context === protocol.CONTEXT_RESOURCE_HMU) {
            this._onHashmapUpdate(plaintext);
        } else if (packet.context === protocol.CONTEXT_NONE) {
            const parsedLxmf = tryParseLxmfDirect(this.rns, plaintext);
            if (parsedLxmf) {
                this.emit('lxmf', parsedLxmf);
            } else {
                this.emit('packet', plaintext);
            }
        } else if (packet.context === protocol.CONTEXT_CHANNEL) {
            if (this._channel) {
                this._sendChannelPacketProof(rawBytes);
                this._channel._onReceive(plaintext);
            }
        } else if (packet.context === protocol.CONTEXT_LRRTT && !this.initiator) {
            const reportedRtt = unpack(plaintext);
            this.rtt = Math.max((Date.now() - this.requestTime) / 1000, reportedRtt);
            this.status = Link.ACTIVE;
            this._activateWatchdog();
            this.emit('established', this);
        } else if (packet.context === protocol.CONTEXT_LINKCLOSE) {
            if (crypto.bytesToHex(plaintext) === crypto.bytesToHex(this.linkId)) this._teardown();
        } else if (packet.context === protocol.CONTEXT_LINKIDENTIFY && !this.initiator) {
            const identityPub = protocol.parse_link_identify_payload(this.linkId, plaintext);
            if (identityPub) {
                this._remoteIdentity = { public: identityPub, hash: protocol.identity_hash(identityPub) };
                this.emit('remote-identified', this._remoteIdentity);
            }
        } else if (packet.context === protocol.CONTEXT_REQUEST) {
            this._handleRequest(protocol.packet_truncated_hash(rawBytes), plaintext);
        } else if (packet.context === protocol.CONTEXT_RESPONSE) {
            const { request_id, response_data } = protocol.parse_response_payload(plaintext);
            this._handleResponse(request_id, response_data);
        }
    }

    // Resolves the pending request() promise matching `requestId`, however
    // the response arrived — a single RESPONSE packet or an isResponse-
    // flagged Resource (see _assembleResource() above).
    _handleResponse(requestId, responseData) {
        const key = crypto.bytesToHex(requestId);
        const pending = this.pendingRequests.get(key);
        if (pending) {
            clearTimeout(pending.timer);
            this.pendingRequests.delete(key);
            pending.resolve(responseData);
        }
    }

    // Transfers `data` to the peer on the other end of this link as a
    // Resource (chunked across multiple packets), resolving once the peer's
    // completion proof is received, or rejecting on timeout or a failed
    // integrity check. Useful for payloads too large for a single Request/
    // Response or LXMF packet. Each segment is bz2-compressed if that's
    // smaller (see shared/rns/compression.js), matching RNS.Resource's own
    // policy exactly, and an incoming compressed transfer from a real RNS
    // peer is transparently decompressed the same way it always was.
    //
    // Payloads larger than one segment's worth (protocol.
    // RESOURCE_SEGMENT_MAX_SIZE) are split into multiple segments, sent one
    // at a time (each with its own full advertise/request/part/proof cycle,
    // linked by a shared "original hash" — see protocol.js's "RNS.Resource"
    // section) — real RNS peers handle this correctly since they only ever
    // trust whatever segment size this sender advertises. The receiver's
    // request window is rate-adaptive, matching RNS.Resource's own growth/
    // fast-rate-promotion logic (see _growResourceWindow() below) — not yet
    // implemented: retry-driven window *shrinking* (no per-part retry/
    // timeout mechanism exists yet), and a segment size much smaller than
    // real RNS's 1MiB-1 — so *sending* an arbitrarily large payload works,
    // but *receiving* one bigger than a single segment from a real peer
    // still doesn't, since that needs HMU packets this project doesn't
    // implement. See compliance.md for the full parity checklist.
    sendResource(data, { timeout = 30000, requestId = null, isRequest = false, isResponse = false } = {}) {
        if (this.status !== Link.ACTIVE) return Promise.reject(new Error('Link is not active'));

        const segments = [];
        for (let offset = 0; offset < data.length; offset += protocol.RESOURCE_SEGMENT_MAX_SIZE) {
            segments.push(data.slice(offset, offset + protocol.RESOURCE_SEGMENT_MAX_SIZE));
        }
        if (segments.length === 0) segments.push(data);
        const totalSegments = segments.length;

        return segments.reduce(
            (chain, chunk, i) => chain.then((originalHash) =>
                this._sendResourceSegment(chunk, i + 1, totalSegments, originalHash, timeout, { requestId, isRequest, isResponse })
                    .then((resourceHash) => originalHash || resourceHash)),
            Promise.resolve(null),
        );
    }

    // Sends a single Resource segment and resolves with that segment's own
    // resourceHash once its completion proof arrives — sendResource() feeds
    // this back in as `originalHash` for the next segment, so every segment
    // after the first is linked back to the transfer's first segment.
    // `requestId`/`isRequest`/`isResponse` tag this Resource as carrying an
    // oversized Link.request()/response payload (see Link.request()/
    // _handleRequest() below) rather than a plain application transfer.
    async _sendResourceSegment(plaintext, segmentIndex, totalSegments, originalHash, timeout, { requestId = null, isRequest = false, isResponse = false } = {}) {
        // Matches RNS.Resource's own policy exactly: always try compressing
        // first, only actually send the compressed bytes if they came out
        // smaller (see compression.js's bz2_compress_if_beneficial()).
        const { data: sendData, compressed } = await compression.bz2_compress_if_beneficial(plaintext);

        let prepared;
        try {
            prepared = protocol.resource_prepare(plaintext, (pt) => protocol.link_encrypt(this.derivedKey, pt), { compressed, sendData });
        } catch (e) {
            return Promise.reject(e);
        }

        const resourceHashHex = crypto.bytesToHex(prepared.resourceHash);
        const advPayload = protocol.build_resource_advertisement({
            transferSize: prepared.transferSize, dataSize: prepared.dataSize, totalParts: prepared.totalParts,
            resourceHash: prepared.resourceHash, randomHash: prepared.randomHash, hashmap: prepared.hashmap,
            segmentIndex, totalSegments, originalHash: originalHash || prepared.resourceHash, compressed: prepared.compressed,
            requestId, isRequest, isResponse,
        });
        const advPacket = protocol.build_link_packet(this.linkId, this.derivedKey, advPayload, protocol.CONTEXT_RESOURCE_ADV);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._outgoingResources.delete(resourceHashHex);
                reject(new Error(`Resource transfer timed out (segment ${segmentIndex}/${totalSegments})`));
            }, timeout);

            this._outgoingResources.set(resourceHashHex, {
                parts: prepared.parts, hashmapEntries: prepared.hashmapEntries,
                expectedProof: prepared.expectedProof,
                resolve: () => resolve(prepared.resourceHash), reject, timer,
            });

            this.rns.sendData(advPacket);
        });
    }

    // Receiver side: a peer advertised a Resource transfer. Always accepts
    // (no accept/reject callback, unlike real RNS) and starts requesting
    // parts in fixed-size windows (see _requestNextResourceParts below). The
    // advertisement's hashmap may be shorter than totalParts (a real sender
    // truncates it to RESOURCE_HASHMAP_MAX_LEN entries per packet) — the
    // rest arrives via HMU packets, requested as needed (see
    // _onHashmapUpdate below).
    _onResourceAdvertisement(plaintext) {
        let adv;
        try {
            adv = protocol.parse_resource_advertisement(plaintext);
        } catch {
            return;
        }
        if (adv.hasMetadata) return; // not implemented — see protocol.js
        if (!adv.totalParts || adv.totalParts > protocol.RESOURCE_MAX_PARTS) return;

        const knownEntries = Math.min(adv.totalParts, Math.floor(adv.hashmap.length / protocol.RESOURCE_MAPHASH_LEN));
        const hashmapEntries = [];
        for (let i = 0; i < knownEntries; i++) {
            hashmapEntries.push(adv.hashmap.slice(i * protocol.RESOURCE_MAPHASH_LEN, (i + 1) * protocol.RESOURCE_MAPHASH_LEN));
        }

        const resourceHashHex = crypto.bytesToHex(adv.resourceHash);
        this._incomingResources.set(resourceHashHex, {
            randomHash: adv.randomHash, resourceHash: adv.resourceHash, compressed: adv.compressed,
            segmentIndex: adv.segmentIndex, totalSegments: adv.totalSegments, originalHash: adv.originalHash,
            requestId: adv.requestId, isRequest: adv.isRequest, isResponse: adv.isResponse,
            hashmapEntries, parts: new Array(adv.totalParts).fill(null),
            receivedCount: 0, consecutiveCompletedHeight: -1, outstandingParts: 0, waitingForHmu: false,
            // Rate-adaptive request window — matches RNS.Resource's own
            // starting values (see protocol.js's RESOURCE_WINDOW* constants).
            window: protocol.RESOURCE_WINDOW,
            windowMax: protocol.RESOURCE_WINDOW_MAX_SLOW,
            windowMin: protocol.RESOURCE_WINDOW_MIN,
            fastRateRounds: 0,
            verySlowRateRounds: 0,
            reqSentAt: 0,
            rttRxdBytes: 0,
            rttRxdBytesAtPartReq: 0,
        });

        this._requestNextResourceParts(resourceHashHex);
    }

    // A sender's response to a hashmap-exhausted request: the next chunk of
    // map hashes for a transfer whose hashmap didn't fit in one
    // advertisement. Matches RNS.Resource.hashmap_update() — appends the new
    // entries and resumes requesting parts.
    _onHashmapUpdate(plaintext) {
        const { resourceHash, hashmap } = protocol.parse_resource_hmu(plaintext);
        const resourceHashHex = crypto.bytesToHex(resourceHash);
        const incoming = this._incomingResources.get(resourceHashHex);
        if (!incoming) return;

        for (let i = 0; i < hashmap.length; i += protocol.RESOURCE_MAPHASH_LEN) {
            incoming.hashmapEntries.push(hashmap.slice(i, i + protocol.RESOURCE_MAPHASH_LEN));
        }
        incoming.waitingForHmu = false;
        this._requestNextResourceParts(resourceHashHex);
    }

    // Requests the next window's worth of not-yet-received parts, starting
    // right after the longest known consecutive run of received parts —
    // matches RNS.Resource.request_next(), including its rate-adaptive
    // window size (see _onResourcePart() below for how the window grows/its
    // ceiling is promoted) and requesting more hashmap via HMU once the
    // known entries run out short of the transfer's real total_parts.
    _requestNextResourceParts(resourceHashHex) {
        const incoming = this._incomingResources.get(resourceHashHex);
        if (!incoming || incoming.waitingForHmu) return;

        const requested = [];
        incoming.outstandingParts = 0;
        let exhausted = false;
        for (let i = incoming.consecutiveCompletedHeight + 1; requested.length < incoming.window && i < incoming.parts.length; i++) {
            if (i >= incoming.hashmapEntries.length) {
                exhausted = true;
                break;
            }
            if (incoming.parts[i] === null) {
                requested.push(incoming.hashmapEntries[i]);
                incoming.outstandingParts++;
            }
        }
        if (requested.length === 0 && !exhausted) return;

        incoming.reqSentAt = Date.now();
        incoming.rttRxdBytesAtPartReq = incoming.rttRxdBytes;
        incoming.waitingForHmu = exhausted;

        const lastMapHash = exhausted ? incoming.hashmapEntries[incoming.hashmapEntries.length - 1] : null;
        const requestPayload = protocol.build_resource_request(incoming.resourceHash, crypto.concat(...requested), { lastMapHash });
        const requestPacket = protocol.build_link_packet(this.linkId, this.derivedKey, requestPayload, protocol.CONTEXT_RESOURCE_REQ);
        this.rns.sendData(requestPacket);
    }

    // Sender side: the receiver requested some parts of a resource we
    // advertised — send back whichever of our already-built parts match,
    // trusting the receiver's own window/pacing entirely (matching real
    // RNS.Resource.request(): the sender doesn't second-guess how many parts
    // it's asked for at once).
    _onResourceRequest(plaintext) {
        const { resourceHash, requestedHashes } = protocol.parse_resource_request(plaintext);
        const pending = this._outgoingResources.get(crypto.bytesToHex(resourceHash));
        if (!pending) return;

        for (const wantedHash of requestedHashes) {
            const wantedHex = crypto.bytesToHex(wantedHash);
            const index = pending.hashmapEntries.findIndex((h) => crypto.bytesToHex(h) === wantedHex);
            if (index === -1) continue;
            this.rns.sendData(protocol.build_resource_part_packet(this.linkId, pending.parts[index]));
        }
    }

    // Receiver side: one part of an in-progress resource transfer arrived.
    // Parts carry no explicit index — like real RNS, a part is identified by
    // matching its content hash against the advertised hashmap, bounded to
    // the currently-outstanding request window (matching
    // RNS.Resource.receive_part()'s bounded search).
    _onResourcePart(partData) {
        for (const [resourceHashHex, incoming] of this._incomingResources.entries()) {
            const windowStart = incoming.consecutiveCompletedHeight >= 0 ? incoming.consecutiveCompletedHeight : 0;
            const windowEnd = Math.min(windowStart + incoming.window, incoming.hashmapEntries.length);
            const mapHash = crypto.bytesToHex(protocol.resource_map_hash(partData, incoming.randomHash));

            let matchedIndex = -1;
            for (let i = windowStart; i < windowEnd; i++) {
                if (crypto.bytesToHex(incoming.hashmapEntries[i]) === mapHash) {
                    matchedIndex = i;
                    break;
                }
            }
            if (matchedIndex === -1) continue;
            if (incoming.parts[matchedIndex] !== null) return; // already have it

            incoming.parts[matchedIndex] = partData;
            incoming.receivedCount++;
            incoming.outstandingParts--;
            incoming.rttRxdBytes += partData.length;

            let cp = incoming.consecutiveCompletedHeight + 1;
            while (cp < incoming.parts.length && incoming.parts[cp] !== null) {
                incoming.consecutiveCompletedHeight = cp;
                cp++;
            }

            if (incoming.receivedCount === incoming.parts.length) {
                this._assembleResource(resourceHashHex, incoming);
            } else if (incoming.outstandingParts <= 0) {
                this._growResourceWindow(incoming);
                this._requestNextResourceParts(resourceHashHex);
            }
            return;
        }
    }

    // Grows the request window (and, if the measured transfer rate over
    // this round has been consistently fast or very slow, promotes/demotes
    // its ceiling) — matches RNS.Resource.receive_part()'s window-adaptation
    // logic (RNS/Resource.py:900-924). Retry-driven window *shrinking* isn't
    // implemented — this project's Resource has no per-part retry/timeout
    // mechanism yet (see compliance.md).
    _growResourceWindow(incoming) {
        if (incoming.window < incoming.windowMax) {
            incoming.window += 1;
            if (incoming.window - incoming.windowMin > protocol.RESOURCE_WINDOW_FLEXIBILITY - 1) {
                incoming.windowMin += 1;
            }
        }

        if (incoming.reqSentAt) {
            const rtt = (Date.now() - incoming.reqSentAt) / 1000;
            const transferred = incoming.rttRxdBytes - incoming.rttRxdBytesAtPartReq;
            if (rtt > 0) {
                const rate = transferred / rtt;

                if (rate > protocol.RESOURCE_RATE_FAST && incoming.fastRateRounds < protocol.RESOURCE_FAST_RATE_THRESHOLD) {
                    incoming.fastRateRounds += 1;
                    if (incoming.fastRateRounds === protocol.RESOURCE_FAST_RATE_THRESHOLD) {
                        incoming.windowMax = protocol.RESOURCE_WINDOW_MAX_FAST;
                    }
                }

                if (incoming.fastRateRounds === 0 && rate < protocol.RESOURCE_RATE_VERY_SLOW
                    && incoming.verySlowRateRounds < protocol.RESOURCE_VERY_SLOW_RATE_THRESHOLD) {
                    incoming.verySlowRateRounds += 1;
                    if (incoming.verySlowRateRounds === protocol.RESOURCE_VERY_SLOW_RATE_THRESHOLD) {
                        incoming.windowMax = protocol.RESOURCE_WINDOW_MAX_VERY_SLOW;
                    }
                }
            }
        }
    }

    // All parts of a resource have arrived: decrypt the reassembled blob,
    // verify it hashes to what was advertised, and — if it checks out —
    // emit it and send the sender a completion proof.
    _assembleResource(resourceHashHex, incoming) {
        this._incomingResources.delete(resourceHashHex);

        const cipherBlob = crypto.concat(...incoming.parts);
        const preEncryptBlob = protocol.link_decrypt(this.derivedKey, cipherBlob);
        if (preEncryptBlob === null) {
            this.emit('resource-failed', { reason: 'decrypt-failed' });
            return;
        }

        let plaintext = preEncryptBlob.slice(protocol.RESOURCE_RANDOM_HASH_LEN);
        if (incoming.compressed) {
            try {
                plaintext = compression.bz2_decompress(plaintext);
            } catch {
                this.emit('resource-failed', { reason: 'decompress-failed' });
                return;
            }
        }
        const calculatedHash = crypto.sha256(crypto.concat(plaintext, incoming.randomHash));
        if (crypto.bytesToHex(calculatedHash) !== resourceHashHex) {
            this.emit('resource-failed', { reason: 'hash-mismatch' });
            return;
        }

        const proofValue = crypto.sha256(crypto.concat(plaintext, calculatedHash));
        this.rns.sendData(protocol.build_resource_proof_packet(this.linkId, incoming.resourceHash, proofValue));

        // Every segment gets proved individually (above), but 'resource' only
        // fires once the *last* segment of a (possibly multi-segment)
        // transfer has arrived, with every segment's plaintext concatenated
        // in order — segments are always sent (and thus concluded) strictly
        // in order, since a real sender never starts segment N+1 until
        // segment N's proof has come back, so a simple ordered accumulator
        // keyed by the shared original_hash is enough.
        const originalHashHex = crypto.bytesToHex(incoming.originalHash);
        let segmented = this._resourceSegments.get(originalHashHex);
        if (!segmented) {
            segmented = { chunks: [] };
            this._resourceSegments.set(originalHashHex, segmented);
        }
        segmented.chunks.push(plaintext);

        if (incoming.segmentIndex >= incoming.totalSegments) {
            this._resourceSegments.delete(originalHashHex);
            const fullData = segmented.chunks.length === 1 ? segmented.chunks[0] : crypto.concat(...segmented.chunks);

            // An oversized Link.request()/response arriving as a Resource
            // (RNS.Link.request()'s fallback — see request()/_handleRequest()
            // below) is routed there instead of surfacing as a generic
            // 'resource' event, matching how real RNS keeps these internal.
            if (incoming.isRequest) {
                const requestId = protocol.resource_request_id(fullData);
                this._handleRequest(requestId, fullData);
                return;
            }
            if (incoming.isResponse) {
                const { request_id, response_data } = protocol.parse_response_payload(fullData);
                this._handleResponse(request_id, response_data);
                return;
            }

            const parsedLxmf = tryParseLxmfDirect(this.rns, fullData);
            if (parsedLxmf) {
                this.emit('lxmf', parsedLxmf);
            } else {
                this.emit('resource', fullData);
            }
        }
    }

    // Sender side: the receiver's completion proof for a resource we sent.
    _onResourceProof(data) {
        const parsed = protocol.parse_resource_proof(data);
        if (!parsed) return;

        const key = crypto.bytesToHex(parsed.resourceHash);
        const pending = this._outgoingResources.get(key);
        if (!pending) return;

        clearTimeout(pending.timer);
        this._outgoingResources.delete(key);

        if (crypto.bytesToHex(parsed.proofValue) === crypto.bytesToHex(pending.expectedProof)) {
            pending.resolve();
        } else {
            pending.reject(new Error('Resource proof did not match the expected value'));
        }
    }

    // Sends a request to whichever peer is on the other end of this link,
    // and resolves with the response data once it's received (or rejects on
    // timeout). A request (or its response) that doesn't fit in a single
    // packet automatically falls back to a Resource transfer, matching
    // RNS.Link.request()'s own fallback exactly (RNS/Link.py:490-506).
    request(path, data, { timeout = 10000 } = {}) {
        if (this.status !== Link.ACTIVE) return Promise.reject(new Error('Link is not active'));

        const payload = protocol.build_request_payload(path, data);

        if (payload.length <= protocol.LINK_MDU) {
            const requestPacket = protocol.build_link_packet(this.linkId, this.derivedKey, payload, protocol.CONTEXT_REQUEST);
            const requestId = protocol.packet_truncated_hash(requestPacket);
            const key = crypto.bytesToHex(requestId);
            return new Promise((resolve, reject) => {
                const timer = setTimeout(() => {
                    this.pendingRequests.delete(key);
                    reject(new Error(`Request to ${path} timed out`));
                }, timeout);
                this.pendingRequests.set(key, { resolve, reject, timer });
                this.rns.sendData(requestPacket);
            });
        }

        const requestId = protocol.resource_request_id(payload);
        const key = crypto.bytesToHex(requestId);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(key);
                reject(new Error(`Request to ${path} timed out`));
            }, timeout);
            this.pendingRequests.set(key, { resolve, reject, timer });
            this.sendResource(payload, { timeout, requestId, isRequest: true }).catch((e) => {
                if (!this.pendingRequests.has(key)) return; // already resolved/rejected via the response
                clearTimeout(timer);
                this.pendingRequests.delete(key);
                reject(e);
            });
        });
    }

    // Looks up a handler registered on this link's destination via
    // Destination.registerRequestHandler() and, if it returns a value,
    // sends it back as a RESPONSE packet — or, if that doesn't fit in one
    // packet, as an isResponse-flagged Resource (matching RNS.Link's own
    // fallback, RNS/Link.py:842-850).
    _handleRequest(requestId, plaintext) {
        const { path_hash, data } = protocol.parse_request_payload(plaintext);
        const handlerEntry = this.destination?.requestHandlers?.get(crypto.bytesToHex(path_hash));
        if (!handlerEntry) return;

        const response = handlerEntry.handler(data, requestId, this);
        if (response === undefined) return;

        const payload = protocol.build_response_payload(requestId, response);
        if (payload.length <= protocol.LINK_MDU) {
            this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, payload, protocol.CONTEXT_RESPONSE));
        } else {
            this.sendResource(payload, { requestId, isResponse: true }).catch(() => {});
        }
    }

    send(data) {
        if (this.status !== Link.ACTIVE) return;
        this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, data, protocol.CONTEXT_NONE));
    }

    // Sends an LXMF message over this established Link, matching LXMF's
    // DIRECT delivery method (LXMessage.py's method=DIRECT, representation
    // chosen the same way: a plain application-data packet if it fits within
    // LINK_MDU, otherwise a Resource — auto-compressed, same as any other
    // Resource here). `this.destination.hash` is the LXMF delivery
    // destination on both ends of the link (the initiator's own outbound
    // destination, or the responder's own inbound one) — see the Link
    // constructor/fromRequest(). The receiving side's onPacket()/
    // _assembleResource() auto-detect a DIRECT LXMF payload and emit an
    // 'lxmf' event instead of a plain 'packet'/'resource' one.
    sendLXMF(source, title, content, fields = {}) {
        if (!source || source.direction !== Destination.IN) {
            throw new Error('LXMF source must be your own IN destination.');
        }
        const payload = protocol.lxmf_build_direct(content, source.identity.private, this.destination.hash, source.hash, null, title, fields);
        if (payload.length <= protocol.LINK_MDU) {
            this.send(payload);
            return Promise.resolve();
        }
        return this.sendResource(payload);
    }

    // Proves `identity` to the peer on the other end of this link — an
    // opt-in authentication step, only meaningful for the initiator (matches
    // RNS.Link.identify()). The responder learns the initiator's real
    // identity (see the 'remote-identified' event/getRemoteIdentity()) but
    // the initiator's anonymity is otherwise preserved — nothing about this
    // link's handshake reveals it unless this is called.
    identify(identity) {
        if (!this.initiator || this.status !== Link.ACTIVE) return;
        const payload = protocol.build_link_identify_payload(this.linkId, identity.private);
        this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, payload, protocol.CONTEXT_LINKIDENTIFY));
    }

    // The initiator's identity, once proven via identify() — null until
    // then. Matches RNS.Link.get_remote_identity().
    getRemoteIdentity() {
        return this._remoteIdentity;
    }

    // Returns this link's Channel (a reliable, sequenced message layer — see
    // shared/rns/channel.js), creating it on first use. Matches
    // RNS.Link.get_channel().
    getChannel() {
        if (!this._channel) this._channel = new Channel(this);
        return this._channel;
    }

    // Sends back an explicit packet delivery proof for a received CHANNEL
    // packet — see protocol.js's build_link_packet_proof().
    _sendChannelPacketProof(rawBytes) {
        const packetHash = protocol.packet_full_hash(rawBytes);
        const proofPacket = protocol.build_link_packet_proof(this.linkId, packetHash, this.sigPrivate);
        this.rns.sendData(proofPacket);
    }

    // Matches RNS.Link's real RTT-adaptive keepalive/stale/timeout state
    // machine (RNS/Link.py __watchdog_job/__update_keepalive), adapted from
    // Python's polling sleep-loop (a dedicated thread per link, woken on a
    // fixed cadence to re-check elapsed time) to a single rescheduled
    // setTimeout: since JS has no threads, the next check is instead
    // recomputed and rescheduled from scratch whenever something that
    // affects it changes (RTT becomes known, a packet arrives, a status
    // transition happens) rather than by polling.
    _updateKeepalive() {
        const keepaliveS = Math.max(
            Math.min(this.rtt * (Link.KEEPALIVE_MAX / Link.KEEPALIVE_MAX_RTT), Link.KEEPALIVE_MAX),
            Link.KEEPALIVE_MIN,
        );
        this.keepaliveMs = keepaliveS * 1000;
        this.staleTimeMs = this.keepaliveMs * Link.STALE_FACTOR;
    }

    _activateWatchdog() {
        this.activatedAt = Date.now();
        this.lastInbound = this.activatedAt;
        this._updateKeepalive();
        this._watchdogTick();
    }

    // Called whenever traffic arrives for this link (see onPacket/onProof)
    // — resets the staleness clock and recovers a STALE link back to
    // ACTIVE, matching RNS.Link's "if self.status == Link.STALE: self.
    // status = Link.ACTIVE" on any inbound packet.
    _noteInbound() {
        if (this.status !== Link.ACTIVE && this.status !== Link.STALE) return;
        this.lastInbound = Date.now();
        if (this.status === Link.STALE) this.status = Link.ACTIVE;
        this._watchdogTick();
    }

    _sendKeepalive() {
        this.lastKeepaliveSent = Date.now();
        this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, new Uint8Array([0xff]), protocol.CONTEXT_KEEPALIVE));
    }

    _scheduleWatchdog(delayMs) {
        clearTimeout(this._watchdogTimer);
        this._watchdogTimer = setTimeout(() => this._watchdogTick(), Math.max(delayMs, 0));
    }

    // Re-evaluates this link's timing state from scratch and schedules the
    // next check — the JS equivalent of one iteration of RNS.Link's
    // __watchdog_job loop.
    _watchdogTick() {
        if (this.status === Link.CLOSED) return;

        if (this.status === Link.PENDING || this.status === Link.HANDSHAKE) {
            const now = Date.now();
            const deadline = this.requestTime + this.establishmentTimeoutMs;
            if (now >= deadline) {
                this.teardownReason = Link.TIMEOUT;
                this._teardown();
                return;
            }
            this._scheduleWatchdog(deadline - now);
            return;
        }

        if (this.status === Link.ACTIVE) {
            const now = Date.now();
            const lastInbound = Math.max(this.lastInbound, this.activatedAt || 0);

            if (now >= lastInbound + this.keepaliveMs) {
                if (this.initiator && now >= this.lastKeepaliveSent + this.keepaliveMs) {
                    this._sendKeepalive();
                }
                if (now >= lastInbound + this.staleTimeMs) {
                    this.status = Link.STALE;
                    this._scheduleWatchdog(this.rtt * Link.KEEPALIVE_TIMEOUT_FACTOR * 1000 + Link.STALE_GRACE * 1000);
                    return;
                }
                this._scheduleWatchdog(this.keepaliveMs);
                return;
            }
            this._scheduleWatchdog((lastInbound + this.keepaliveMs) - now);
            return;
        }

        if (this.status === Link.STALE) {
            this.teardownReason = Link.TIMEOUT;
            this._sendTeardownPacket();
            this._teardown();
        }
    }

    _sendTeardownPacket() {
        if (this.derivedKey) {
            this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, this.linkId, protocol.CONTEXT_LINKCLOSE));
        }
    }

    close() {
        if (this.status === Link.CLOSED) return;
        if (this.status !== Link.PENDING) this._sendTeardownPacket();
        this.teardownReason = Link.INITIATOR_CLOSED;
        this._teardown();
    }

    _teardown() {
        this.status = Link.CLOSED;
        clearTimeout(this._watchdogTimer);
        this.rns.links.delete(crypto.bytesToHex(this.linkId));
        for (const pending of this._outgoingResources.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Link closed before resource transfer completed'));
        }
        this._outgoingResources.clear();
        this._incomingResources.clear();
        this._resourceSegments.clear();
        for (const pending of this.pendingRequests.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Link closed before a response was received'));
        }
        this.pendingRequests.clear();
        if (this._channel) this._channel._shutdown();
        this.emit('closed', this);
    }
}

export class Interface {
    constructor(name) {
        this.name = name;
        this.rns = null;
    }
    connect() {}
    sendData(data) { throw new Error("Not implemented"); }
    // Interfaces that can address one specific neighbor out of several (e.g.
    // one of many WebRTC peer connections) should override this for
    // point-to-point next-hop forwarding; the default just broadcasts.
    sendDataToPeer(peerId, data) { this.sendData(data); }
    // Broadcasts to every neighbor on this interface except one — needed so
    // that flooding (announces, opaque relay) can relay between two peers on
    // the *same* multi-peer interface (e.g. two WebRTC connections on one
    // browser peer acting as a relay) without echoing back to whoever just
    // sent it. Interfaces that don't distinguish neighbors (the common case:
    // one Interface object per link) can't tell "the sender" apart from
    // "everyone on this interface" — since the sender IS the only neighbor,
    // the safe default is to send to no one, matching the old behavior of
    // simply never rebroadcasting back out the interface a packet arrived
    // on. Broadcasting here would echo the packet straight back to whoever
    // just sent it.
    sendDataExcluding(excludedPeerId, data) {}
}
