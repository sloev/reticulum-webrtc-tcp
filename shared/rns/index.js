import * as protocol from './protocol.js';
import { EventEmitter } from 'events';
import * as crypto from './crypto.js';

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
                    this.emit('announce', announce);
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
                    if (link) link.onData(packet, data);
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

        const decrypted = protocol.message_decrypt(packet, this.identity.public, [this.identity.ratchetPrivate]);
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
        const link = new Link(this.rns, this, false);
        link.accept(packet, rawBytes);
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

export class Link extends EventEmitter {
    constructor(rns, destination, initiator=true) {
        super();
        this.rns = rns;
        this.destination = destination;
        this.initiator = initiator;
        this.status = 'PENDING';
        this.hash = new Uint8Array(16); // Will be set to link ID
        this.shared_key = null;
    }

    async accept(link_request_packet, raw_bytes) {
        this.peer_pub = link_request_packet.data.slice(0, 32);
        this.hash = crypto.sha256(raw_bytes).slice(0, 16);
        this.rns.links.set(crypto.bytesToHex(this.hash), this);

        // Generate ephemeral key for this link
        const ephemeral_priv = crypto.private_ratchet();
        const ephemeral_pub = crypto.public_ratchet(ephemeral_priv);

        // Compute shared secret
        const shared_secret = crypto.x25519_exchange(ephemeral_priv, this.peer_pub);
        this.shared_key = crypto.hkdf(shared_secret, 64, this.hash);

        // Build link proof packet
        const proofData = crypto.concat(ephemeral_pub, crypto.ed25519_sign(this.destination.identity.private.slice(32), this.hash));

        const packet = {
            header_type: 0,
            context_flag: 0,
            transport_type: 0,
            destination_type: protocol.DEST_LINK,
            packet_type: protocol.PACKET_PROOF,
            hops: 0,
            destination_hash: this.hash,
            context: protocol.CONTEXT_LRPROOF,
            data: proofData
        };
        this.rns.sendData(protocol.packet_pack(packet));
        this.status = 'ACTIVE';
        this.destination.emit('link', this);
    }

    send(data) {
        if (this.status !== 'ACTIVE' || !this.shared_key) return;

        const hmac_key = this.shared_key.slice(0, 32);
        const aes_key = this.shared_key.slice(32);

        const iv = crypto.randomBytes(16);
        const ciphertext = crypto.aes_cbc_encrypt(aes_key, iv, data);
        const signed_data = crypto.concat(iv, ciphertext);
        const message_hmac = crypto.hmac_sha256(hmac_key, signed_data);

        const packet_data = crypto.concat(signed_data, message_hmac);

        const packet = {
            header_type: 0,
            context_flag: 0,
            transport_type: 0,
            destination_type: protocol.DEST_LINK,
            packet_type: protocol.PACKET_DATA,
            hops: 0,
            destination_hash: this.hash,
            context: protocol.CONTEXT_NONE,
            data: packet_data
        };
        this.rns.sendData(protocol.packet_pack(packet));
    }

    onData(packet, raw_bytes) {
        if (!this.shared_key) return;

        const hmac_key = this.shared_key.slice(0, 32);
        const aes_key = this.shared_key.slice(32);

        const rest = packet.data;
        if (rest.length < 48) return;

        const signed_data = rest.slice(0, -32);
        const received_hmac = rest.slice(-32);
        const expected_hmac = crypto.hmac_sha256(hmac_key, signed_data);

        let hmac_match = true;
        for (let i=0; i<32; i++) {
            if (expected_hmac[i] !== received_hmac[i]) hmac_match = false;
        }
        if (!hmac_match) return;

        const iv = signed_data.slice(0, 16);
        const ciphertext = signed_data.slice(16);
        const decrypted = crypto.aes_cbc_decrypt(aes_key, iv, ciphertext);

        this.emit('packet', decrypted);
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
