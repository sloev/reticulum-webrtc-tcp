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

    onPacketReceived(data, receivingInterface) {
        try {
            if ((data[0] & 0x80) === 0x80) {
               for (const iface of this.interfaces) {
                   if (iface !== receivingInterface) {
                       iface.sendData(data);
                   }
               }
               return;
            }

            const packet = protocol.packet_unpack(data);
            if (!packet) return;

            const destHex = crypto.bytesToHex(packet.destination_hash);
            const destination = this.destinations.get(destHex);

            if (packet.packet_type === protocol.PACKET_ANNOUNCE) {
                const announce = protocol.validate_announce(packet);
                if (announce) {
                    const idHash = crypto.bytesToHex(packet.destination_hash);
                    this.identities.set(idHash, {
                        public_key: announce.public_key,
                        ratchet: announce.ratchet,
                        app_data: announce.app_data
                    });
                    this.emit('announce', { ...announce, destination_hash: packet.destination_hash });
                    // Rebroadcast to other interfaces
                    for (const iface of this.interfaces) {
                        if (iface !== receivingInterface) {
                            iface.sendData(data);
                        }
                    }
                }
            } else if (packet.packet_type === protocol.PACKET_LINKREQUEST) {
                if (destination) destination.onLinkRequest(packet, data);
            } else if (packet.packet_type === protocol.PACKET_DATA) {
                if (packet.destination_type === protocol.DEST_LINK) {
                    const link = this.links.get(destHex);
                    if (link) link.onPacket(packet);
                } else if (destination) {
                    destination.onData(packet);
                }
            } else if (packet.packet_type === protocol.PACKET_PROOF) {
                if (packet.destination_type === protocol.DEST_LINK) {
                    const link = this.links.get(destHex);
                    if (link) link.onProof(packet);
                } else if (destination) {
                    destination.onProof(packet);
                }
            }
        } catch (e) {
            console.error("Error processing packet:", e);
        }
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

    send(data) {
        if (this.direction !== Destination.OUT) {
            throw new Error("Can only send to OUT destinations directly without a Link.");
        }

        const knownIdentity = this.rns.identities.get(crypto.bytesToHex(this.hash));
        if (!knownIdentity) {
            console.error("Cannot send data: Destination identity/ratchet not known. Waiting for announce.");
            return;
        }

        const dataPacket = protocol.build_data(data, knownIdentity.public_key, knownIdentity.ratchet, this.fullName);
        this.rns.sendData(dataPacket);
    }

    sendLXMF(title, content) {
        if (this.direction !== Destination.OUT) {
            throw new Error("Can only send to OUT destinations.");
        }

        const knownIdentity = this.rns.identities.get(crypto.bytesToHex(this.hash));
        if (!knownIdentity) {
            console.error("Cannot send LXMF: Destination identity not known.");
            return;
        }

        const sourcePriv = this.identity ? this.identity.private : crypto.private_identity();

        const lxmfMsg = protocol.lxmf_build(content, sourcePriv, this.hash, null, null, title);
        const dataPacket = protocol.build_data(lxmfMsg, knownIdentity.public_key, knownIdentity.ratchet, this.fullName);
        this.rns.sendData(dataPacket);
    }

    onData(packet) {
        if (this.direction === Destination.OUT) return;

        // Try the destination's current ratchet first, then fall back to the
        // identity's own X25519 key, matching RNS.Identity.decrypt()'s fallback
        // for senders who didn't have (or use) an announced ratchet.
        const decrypted = protocol.message_decrypt(packet, this.identity.public, [this.identity.ratchetPrivate, this.identity.private.slice(0, 32)]);
        if (decrypted) {
            const knownIdentities = Array.from(this.rns.identities.values());
            let parsedLxmf = null;
            let senderPub = null;

            for (const id of knownIdentities) {
                const parsed = protocol.lxmf_parse(decrypted, this.hash, id.public_key);
                if (parsed && parsed.valid) {
                    parsedLxmf = parsed;
                    senderPub = id.public_key;
                    break;
                }
            }

            if (parsedLxmf) {
                this.emit('lxmf', parsedLxmf);
            } else {
                this.emit('packet', { data: decrypted, packet });
            }
        }
    }

    onLinkRequest(packet, rawBytes) {
        const link = Link.fromRequest(this.rns, this, packet, rawBytes);
        if (link) this.emit('link', link);
    }

    onProof(packet) {
        this.emit('proof', packet);
    }

    announce() {
        if (this.identity) {
            const packet = protocol.build_announce(this.identity.private, this.identity.public, this.hash, this.identity.ratchetPrivate, this.identity.ratchetPublic, this.fullName);
            this.rns.sendData(packet);
        }
    }
}

// Wire-compatible with RNS.Link's core handshake (LINKREQUEST -> PROOF ->
// LRRTT), per-link Token encryption, KEEPALIVE, and LINKCLOSE — verified
// byte-for-byte against the real `rns` package (see protocol.js's "RNS.Link
// wire format" section and test/rns-compliance.test.js).
//
// Not implemented: RNS.Link's exact RTT-adaptive keepalive/stale/timeout
// state machine (this uses simple fixed intervals instead), Resource
// transfers, Request/Response, Channel, and packet-level delivery proofs
// (RNS.Packet.prove()/link.validate()). See README's Compliance section.
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
    // to this link arrives.
    onProof(packet) {
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
    // KEEPALIVE ping/pong, or LINKCLOSE teardown.
    onPacket(packet) {
        if (this.status === Link.CLOSED) return;

        if (packet.context === protocol.CONTEXT_KEEPALIVE) {
            if (!this.initiator && packet.data.length === 1 && packet.data[0] === 0xff) {
                this.rns.sendData(protocol.build_link_packet(this.linkId, this.derivedKey, new Uint8Array([0xfe]), protocol.CONTEXT_KEEPALIVE));
            }
            return;
        }

        if (!this.derivedKey) return;
        const plaintext = protocol.link_decrypt(this.derivedKey, packet.data);
        if (plaintext === null) return;

        if (packet.context === protocol.CONTEXT_NONE) {
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
        }
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
}
