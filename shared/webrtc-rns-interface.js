import Interface from "@liamcottle/rns.js/src/interfaces/interface.js";
import { Packet } from "@liamcottle/rns.js";

export class WebRTCInterface extends Interface {
    constructor(name) {
        super(name);
        this.peers = new Map();
        this.dataChannels = new Map();
    }

    connect() {
        // Automatically connected when added to RNS, but connections are managed externally
    }

    addPeer(peerId, pc, dc) {
        this.peers.set(peerId, pc);
        this.dataChannels.set(peerId, dc);

        dc.onmessage = (event) => {
            const data = new Uint8Array(event.data);
            this.onDataReceived(data);
        };
        dc.onclose = () => {
            this.peers.delete(peerId);
            this.dataChannels.delete(peerId);
            console.log(`[WebRTCInterface] Peer ${peerId} disconnected`);
        };
    }

    sendData(data) {
        for (const [peerId, dc] of this.dataChannels.entries()) {
            if (dc.readyState === 'open') {
                dc.send(data);
            }
        }
    }

    sendDataToPeer(peerId, data) {
        const dc = this.dataChannels.get(peerId);
        if (dc && dc.readyState === 'open') {
            dc.send(data);
        }
    }

    onDataReceived(data) {
        // fixme: skipping ifac packets for now
        if ((data[0] & 0x80) === 0x80) {
            console.log("IFAC packet received. SKIPPING FOR NOW");
            return;
        }

        try {
            const packet = Packet.fromBytes(data);
            if (this.rns) {
                this.rns.onPacketReceived(packet, this);
            }
        } catch (e) {
            console.error("Failed to parse packet", e);
        }
    }
}
