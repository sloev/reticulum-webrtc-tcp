import * as protocol from './protocol.js';
import { EventEmitter } from 'events';
import * as crypto from './crypto.js';
import { pack, unpack } from 'msgpackr';

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

    // Broadcasts a path request for a destination hash, matching the
    // non-transport-enabled form of RNS.Transport.request_path() (this
    // project has no persistent "transport identity" concept).
    requestPath(destination_hash, tag = crypto.randomBytes(16)) {
        this.sendData(protocol.build_path_request(destination_hash, tag));
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
// wire format" section and test/rns-compliance.test.js).
//
// Request/Response is implemented for the direct-packet (fits-in-one-packet)
// form only. Not implemented: RNS.Link's exact RTT-adaptive keepalive/
// stale/timeout state machine (this uses simple fixed intervals instead),
// Resource transfers (including the Request/Response fallback to one when a
// request or response doesn't fit in a single packet), Channel, and
// packet-level delivery proofs (RNS.Packet.prove()/link.validate()). See
// README's Compliance section.
export class Link extends EventEmitter {
    static PENDING = 0;
    static HANDSHAKE = 1;
    static ACTIVE = 2;
    static CLOSED = 4;

    static DEFAULT_MTU = 500;
    static ESTABLISHMENT_TIMEOUT_MS = 15000;
    static KEEPALIVE_INTERVAL_MS = 30000;
    static STALE_AFTER_MS = Link.KEEPALIVE_INTERVAL_MS * 2.5;

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
        this._keepaliveTimer = null;
        this._establishmentTimer = null;
        this.pendingRequests = new Map(); // request_id hex -> { resolve, reject, timer }
        this._outgoingResources = new Map(); // resource_hash hex -> { parts, hashmapEntries, expectedProof, resolve, reject, timer }
        this._incomingResources = new Map(); // resource_hash hex -> { randomHash, hashmapEntries, parts, receivedCount }

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

        this.rns.links.set(crypto.bytesToHex(this.linkId), this);
        this.requestTime = Date.now();
        this.rns.sendData(requestRaw);
        this._armEstablishmentTimeout();
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
        link._keepaliveTimer = null;
        link._establishmentTimer = null;
        link.pendingRequests = new Map();
        link._outgoingResources = new Map();
        link._incomingResources = new Map();

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

        const proofRaw = protocol.build_link_proof(link.linkId, destination.identity.private, link.xPublic, link.mtu);
        link.rns.sendData(proofRaw);
        link._armEstablishmentTimeout();

        return link;
    }

    _armEstablishmentTimeout() {
        clearTimeout(this._establishmentTimer);
        this._establishmentTimer = setTimeout(() => {
            if (this.status !== Link.ACTIVE) this.close();
        }, Link.ESTABLISHMENT_TIMEOUT_MS);
    }

    // Initiator-side: called when a PROOF (context=LRPROOF) packet addressed
    // to this link arrives. Also handles RESOURCE_PRF (a Resource transfer's
    // completion proof — see sendResource()/_onResourceProof below), which
    // can arrive on either side of the link, at any point after it's ACTIVE,
    // unlike the handshake's LRPROOF.
    onProof(packet) {
        if (packet.context === protocol.CONTEXT_RESOURCE_PRF) {
            this._onResourceProof(packet.data);
            return;
        }

        if (this.status !== Link.PENDING || !this.initiator) return;

        const validated = protocol.validate_link_proof(packet, this.linkId, this.destination.identity.public.slice(32));
        if (!validated) return;

        this.peerXPublic = validated.peer_x_pub;
        this.mtu = validated.mtu || this.mtu;
        this.derivedKey = protocol.link_handshake(this.xPrivate, this.peerXPublic, this.linkId);
        this.rtt = (Date.now() - this.requestTime) / 1000;
        this.status = Link.ACTIVE;
        clearTimeout(this._establishmentTimer);

        let rttData = pack(this.rtt);
        if (!(rttData instanceof Uint8Array)) rttData = new Uint8Array(rttData);
        const rttPacket = protocol.build_link_packet(this.linkId, this.derivedKey, rttData, protocol.CONTEXT_LRRTT);
        this.rns.sendData(rttPacket);

        this._startKeepalive();
        this.emit('established', this);
    }

    // Dispatches an incoming DATA packet addressed to this link by context:
    // application data (NONE), the initiator's RTT report (LRRTT),
    // KEEPALIVE ping/pong, LINKCLOSE teardown, a REQUEST/RESPONSE, or a
    // Resource transfer's advertisement/part/request. `rawBytes` is needed
    // (only for REQUEST) to compute the request_id.
    onPacket(packet, rawBytes) {
        if (this.status === Link.CLOSED) return;

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
        } else if (packet.context === protocol.CONTEXT_NONE) {
            this.emit('packet', plaintext);
        } else if (packet.context === protocol.CONTEXT_LRRTT && !this.initiator) {
            const reportedRtt = unpack(plaintext);
            this.rtt = Math.max((Date.now() - this.requestTime) / 1000, reportedRtt);
            this.status = Link.ACTIVE;
            clearTimeout(this._establishmentTimer);
            this._startKeepalive();
            this.emit('established', this);
        } else if (packet.context === protocol.CONTEXT_LINKCLOSE) {
            if (crypto.bytesToHex(plaintext) === crypto.bytesToHex(this.linkId)) this._teardown();
        } else if (packet.context === protocol.CONTEXT_REQUEST) {
            this._handleRequest(protocol.packet_truncated_hash(rawBytes), plaintext);
        } else if (packet.context === protocol.CONTEXT_RESPONSE) {
            const { request_id, response_data } = protocol.parse_response_payload(plaintext);
            const key = crypto.bytesToHex(request_id);
            const pending = this.pendingRequests.get(key);
            if (pending) {
                clearTimeout(pending.timer);
                this.pendingRequests.delete(key);
                pending.resolve(response_data);
            }
        }
    }

    // Transfers `data` to the peer on the other end of this link as a
    // Resource (chunked across multiple packets), resolving once the peer's
    // completion proof is received, or rejecting on timeout or a failed
    // integrity check. Useful for payloads too large for a single Request/
    // Response or LXMF packet. See protocol.js's "RNS.Resource" section for
    // exactly what's implemented (single-segment, uncompressed, fixed-size
    // request window) versus real RNS's Resource.
    sendResource(data, { timeout = 30000 } = {}) {
        if (this.status !== Link.ACTIVE) return Promise.reject(new Error('Link is not active'));

        let prepared;
        try {
            prepared = protocol.resource_prepare(data, (plaintext) => protocol.link_encrypt(this.derivedKey, plaintext));
        } catch (e) {
            return Promise.reject(e);
        }

        const resourceHashHex = crypto.bytesToHex(prepared.resourceHash);
        const advPayload = protocol.build_resource_advertisement({
            transferSize: prepared.transferSize, dataSize: prepared.dataSize, totalParts: prepared.totalParts,
            resourceHash: prepared.resourceHash, randomHash: prepared.randomHash, hashmap: prepared.hashmap,
        });
        const advPacket = protocol.build_link_packet(this.linkId, this.derivedKey, advPayload, protocol.CONTEXT_RESOURCE_ADV);

        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this._outgoingResources.delete(resourceHashHex);
                reject(new Error('Resource transfer timed out'));
            }, timeout);

            this._outgoingResources.set(resourceHashHex, {
                parts: prepared.parts, hashmapEntries: prepared.hashmapEntries,
                expectedProof: prepared.expectedProof, resolve, reject, timer,
            });

            this.rns.sendData(advPacket);
        });
    }

    // Receiver side: a peer advertised a Resource transfer. Always accepts
    // (no accept/reject callback, unlike real RNS) and starts requesting
    // parts in fixed-size windows (see _requestNextResourceParts below).
    _onResourceAdvertisement(plaintext) {
        let adv;
        try {
            adv = protocol.parse_resource_advertisement(plaintext);
        } catch {
            return;
        }
        if (adv.compressed || adv.split || adv.hasMetadata) return; // not implemented — see protocol.js
        if (!adv.totalParts || adv.totalParts > protocol.RESOURCE_MAX_PARTS) return;

        const hashmapEntries = [];
        for (let i = 0; i < adv.totalParts; i++) {
            hashmapEntries.push(adv.hashmap.slice(i * protocol.RESOURCE_MAPHASH_LEN, (i + 1) * protocol.RESOURCE_MAPHASH_LEN));
        }

        const resourceHashHex = crypto.bytesToHex(adv.resourceHash);
        this._incomingResources.set(resourceHashHex, {
            randomHash: adv.randomHash, resourceHash: adv.resourceHash,
            hashmapEntries, parts: new Array(adv.totalParts).fill(null),
            receivedCount: 0, consecutiveCompletedHeight: -1, outstandingParts: 0,
        });

        this._requestNextResourceParts(resourceHashHex);
    }

    // Requests the next window's worth of not-yet-received parts, starting
    // right after the longest known consecutive run of received parts —
    // matches RNS.Resource.request_next(), but with a fixed window instead
    // of one that adapts to measured throughput (see protocol.js's
    // "RNS.Resource" section).
    _requestNextResourceParts(resourceHashHex) {
        const incoming = this._incomingResources.get(resourceHashHex);
        if (!incoming) return;

        const requested = [];
        incoming.outstandingParts = 0;
        for (let i = incoming.consecutiveCompletedHeight + 1; i < incoming.hashmapEntries.length && requested.length < protocol.RESOURCE_WINDOW; i++) {
            if (incoming.parts[i] === null) {
                requested.push(incoming.hashmapEntries[i]);
                incoming.outstandingParts++;
            }
        }
        if (requested.length === 0) return;

        const requestPayload = protocol.build_resource_request(incoming.resourceHash, crypto.concat(...requested));
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
            const windowEnd = Math.min(windowStart + protocol.RESOURCE_WINDOW, incoming.hashmapEntries.length);
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

            let cp = incoming.consecutiveCompletedHeight + 1;
            while (cp < incoming.parts.length && incoming.parts[cp] !== null) {
                incoming.consecutiveCompletedHeight = cp;
                cp++;
            }

            if (incoming.receivedCount === incoming.hashmapEntries.length) {
                this._assembleResource(resourceHashHex, incoming);
            } else if (incoming.outstandingParts <= 0) {
                this._requestNextResourceParts(resourceHashHex);
            }
            return;
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

        const plaintext = preEncryptBlob.slice(protocol.RESOURCE_RANDOM_HASH_LEN);
        const calculatedHash = crypto.sha256(crypto.concat(plaintext, incoming.randomHash));
        if (crypto.bytesToHex(calculatedHash) !== resourceHashHex) {
            this.emit('resource-failed', { reason: 'hash-mismatch' });
            return;
        }

        const proofValue = crypto.sha256(crypto.concat(plaintext, calculatedHash));
        this.rns.sendData(protocol.build_resource_proof_packet(this.linkId, incoming.resourceHash, proofValue));

        this.emit('resource', plaintext);
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
    // and resolves with the response data once it's received (or rejects
    // on timeout). Only the direct-packet form is implemented — a request or
    // response that doesn't fit in a single packet has no fallback here.
    // For larger payloads, use sendResource() explicitly instead.
    request(path, data, { timeout = 10000 } = {}) {
        if (this.status !== Link.ACTIVE) return Promise.reject(new Error('Link is not active'));

        const payload = protocol.build_request_payload(path, data);
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

    // Looks up a handler registered on this link's destination via
    // Destination.registerRequestHandler() and, if it returns a value,
    // sends it back as a RESPONSE packet.
    _handleRequest(requestId, plaintext) {
        const { path_hash, data } = protocol.parse_request_payload(plaintext);
        const handlerEntry = this.destination?.requestHandlers?.get(crypto.bytesToHex(path_hash));
        if (!handlerEntry) return;

        const response = handlerEntry.handler(data, requestId, this);
        if (response === undefined) return;

        const payload = protocol.build_response_payload(requestId, response);
        this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, payload, protocol.CONTEXT_RESPONSE));
    }

    send(data) {
        if (this.status !== Link.ACTIVE) return;
        this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, data, protocol.CONTEXT_NONE));
    }

    _startKeepalive() {
        clearInterval(this._keepaliveTimer);
        if (!this.initiator) return;
        this._keepaliveTimer = setInterval(() => {
            this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, new Uint8Array([0xff]), protocol.CONTEXT_KEEPALIVE));
        }, Link.KEEPALIVE_INTERVAL_MS);
    }

    close() {
        if (this.status === Link.CLOSED) return;
        if (this.status !== Link.PENDING && this.derivedKey) {
            this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, this.linkId, protocol.CONTEXT_LINKCLOSE));
        }
        this._teardown();
    }

    _teardown() {
        this.status = Link.CLOSED;
        clearTimeout(this._establishmentTimer);
        clearInterval(this._keepaliveTimer);
        this.rns.links.delete(crypto.bytesToHex(this.linkId));
        for (const pending of this._outgoingResources.values()) {
            clearTimeout(pending.timer);
            pending.reject(new Error('Link closed before resource transfer completed'));
        }
        this._outgoingResources.clear();
        this._incomingResources.clear();
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
