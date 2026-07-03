import { Interface } from "./rns/index.js";
import { EventEmitter } from "events";

export class WebRTCInterface extends Interface {
    constructor(name) {
        super(name);
        this.peers = new Map();
        this.dataChannels = new Map();
        this.events = new EventEmitter();
    }

    on(name, listener) {
        this.events.on(name, listener);
    }

    connect() {
        // Automatically connected when added to RNS
    }

    addPeer(peerId, pc, dc) {
        this.peers.set(peerId, pc);
        this.dataChannels.set(peerId, dc);
        dc.binaryType = 'arraybuffer';
        this.events.emit('peer-connected', peerId);

        dc.onmessage = (event) => {
            let data;
            if (event.data instanceof ArrayBuffer) {
                data = new Uint8Array(event.data);
            } else if (Buffer.isBuffer(event.data)) {
                data = new Uint8Array(event.data);
            } else {
                // Try converting blob/text
                data = new Uint8Array(event.data);
            }
            this.onDataReceived(data);
        };
        dc.onclose = () => {
            this.peers.delete(peerId);
            this.dataChannels.delete(peerId);
            console.log(`[WebRTCInterface] Peer ${peerId} disconnected`);
            this.events.emit('peer-disconnected', peerId);
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
        try {
            if (this.rns) {
                // Pass everything to the RNS stack exactly as it arrived
                this.rns.onPacketReceived(data, this);
            }
        } catch (e) {
            console.error("Failed to parse packet", e);
        }
    }
}
