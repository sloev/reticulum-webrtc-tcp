// RNS.Channel: reliable, bidirectional, sequenced message delivery over a
// Link, with a self-adjusting send window based on measured RTT. See
// protocol.js's "RNS.Channel" section for the wire format (verified
// byte-for-byte against the real `rns` package). Obtained via
// `link.getChannel()`, matching RNS.Link.get_channel() — not instantiated
// directly.
//
// Ported fairly directly from RNS.Channel (retries via explicit packet
// delivery proofs/timeouts, the growing/shrinking window, the sequence
// dedup/reorder window on receive) rather than simplified, since it's a
// mostly mechanical translation and real RNS peers rely on this exact
// timing/window behavior for interop. Not implemented: MessageBase-style
// registered message *classes* — real RNS uses them purely as an ergonomic
// wrapper around a numeric MSGTYPE (the only part that's actually on the
// wire), so this exposes msgtype/payload bytes directly instead.
import * as protocol from './protocol.js';
import * as crypto from './crypto.js';
import { EventEmitter } from 'events';

export class ChannelError extends Error {
    constructor(type, message) {
        super(message);
        this.type = type;
    }
}

export class Channel extends EventEmitter {
    // The initial window size at channel setup.
    static WINDOW = 2;

    // Absolute minimum window size.
    static WINDOW_MIN = 2;
    static WINDOW_MIN_LIMIT_SLOW = 2;
    static WINDOW_MIN_LIMIT_MEDIUM = 5;
    static WINDOW_MIN_LIMIT_FAST = 16;

    static WINDOW_MAX_SLOW = 5;
    static WINDOW_MAX_MEDIUM = 12;
    static WINDOW_MAX_FAST = 48;
    // For calculating the receive dedup/reorder window, this must be set to
    // the global maximum window (matches RNS.Channel.WINDOW_MAX).
    static WINDOW_MAX = 48;

    static FAST_RATE_THRESHOLD = 10;

    static RTT_FAST = 0.18;
    static RTT_MEDIUM = 0.75;
    static RTT_SLOW = 1.45;

    static WINDOW_FLEXIBILITY = 4;

    static SEQ_MODULUS = 0x10000;
    static MAX_TRIES = 5;

    constructor(link) {
        super();
        this.link = link;
        this.txRing = []; // { sequence, packetRaw, packetHash, tries, delivered, timer }
        this.rxRing = []; // { sequence, msgtype, data }
        this.nextSequence = 0;
        this.nextRxSequence = 0;
        this._pendingProofs = new Map(); // packet hash hex -> tx entry
        this._handlers = [];
        this.fastRateRounds = 0;
        this.mediumRateRounds = 0;

        if (link.rtt && link.rtt > Channel.RTT_SLOW) {
            this.window = 1;
            this.windowMax = 1;
            this.windowMin = 1;
            this.windowFlexibility = 1;
        } else {
            this.window = Channel.WINDOW;
            this.windowMax = Channel.WINDOW_MAX_SLOW;
            this.windowMin = Channel.WINDOW_MIN;
            this.windowFlexibility = Channel.WINDOW_FLEXIBILITY;
        }
    }

    // Maximum Data Unit: bytes available for a message payload in a single
    // send() (the Link's own MDU minus this envelope's 6-byte header).
    get mdu() {
        return protocol.LINK_MDU - protocol.CHANNEL_HEADER_SIZE;
    }

    addMessageHandler(handler) {
        if (!this._handlers.includes(handler)) this._handlers.push(handler);
    }

    removeMessageHandler(handler) {
        const i = this._handlers.indexOf(handler);
        if (i !== -1) this._handlers.splice(i, 1);
    }

    isReadyToSend() {
        const outstanding = this.txRing.reduce((n, e) => n + (e.delivered ? 0 : 1), 0);
        return outstanding < this.window;
    }

    // Sends `data` (a Uint8Array) tagged with `msgtype` (a u16; values
    // >= 0xf000 are system-reserved, see protocol.js's
    // CHANNEL_MSGTYPE_STREAM_DATA). Throws a ChannelError synchronously if
    // the channel isn't ready or the message doesn't fit; otherwise returns
    // the tx-ring entry, which this Channel emits as 'delivered' or times
    // out on (eventually tearing down the Link after too many retries).
    send(msgtype, data = new Uint8Array(0)) {
        if (!this.isReadyToSend()) {
            throw new ChannelError('ME_LINK_NOT_READY', 'Channel is not ready to send');
        }

        const sequence = this.nextSequence;
        const envelopeRaw = protocol.build_channel_envelope(msgtype, sequence, data);
        if (envelopeRaw.length > protocol.LINK_MDU) {
            throw new ChannelError('ME_TOO_BIG', `Packed message too big for packet: ${envelopeRaw.length} > ${protocol.LINK_MDU}`);
        }
        this.nextSequence = (sequence + 1) % Channel.SEQ_MODULUS;

        const packetRaw = protocol.build_link_packet(this.link.linkId, this.link.derivedKey, envelopeRaw, protocol.CONTEXT_CHANNEL);
        const packetHash = protocol.packet_full_hash(packetRaw);

        const entry = { sequence, packetRaw, packetHash, tries: 1, delivered: false, timer: null };
        this.txRing.push(entry);
        this._pendingProofs.set(crypto.bytesToHex(packetHash), entry);

        this.link.rns.sendData(packetRaw);
        this._armTimeout(entry);

        return entry;
    }

    _packetTimeoutMs(tries) {
        const rtt = this.link.rtt || 0;
        const seconds = Math.pow(1.5, tries - 1) * Math.max(rtt * 2.5, 0.025) * (this.txRing.length + 1.5);
        return seconds * 1000;
    }

    _armTimeout(entry) {
        clearTimeout(entry.timer);
        entry.timer = setTimeout(() => this._onTimeout(entry), this._packetTimeoutMs(entry.tries));
    }

    _onTimeout(entry) {
        if (entry.delivered) return;

        if (entry.tries >= Channel.MAX_TRIES) {
            this.emit('error', new Error('Retry count exceeded on channel, tearing down Link.'));
            this._shutdown();
            this.link.close();
            return;
        }

        entry.tries += 1;
        if (this.window > this.windowMin) {
            this.window -= 1;
            if (this.windowMax > this.windowMin + this.windowFlexibility) this.windowMax -= 1;
        }

        this.link.rns.sendData(entry.packetRaw);
        this._armTimeout(entry);
    }

    // Called by Link.onProof() for an explicit packet delivery proof
    // (context NONE, packet_type PROOF) addressed to this link while a
    // channel is open. Returns true once it's been matched to a pending
    // send() (whether or not it's found the exact hash — the caller doesn't
    // need to do anything else with it either way).
    _onPacketProof(packet) {
        const peerSigPub = this.link.initiator
            ? this.link.destination.identity.public.slice(32)
            : this.link.peerSigPublic;
        const packetHash = protocol.validate_link_packet_proof(packet, peerSigPub);
        if (!packetHash) return true;

        const hex = crypto.bytesToHex(packetHash);
        const entry = this._pendingProofs.get(hex);
        if (!entry) return true;
        this._pendingProofs.delete(hex);
        this._onDelivered(entry);
        return true;
    }

    _onDelivered(entry) {
        if (entry.delivered) return;
        entry.delivered = true;
        clearTimeout(entry.timer);
        const i = this.txRing.indexOf(entry);
        if (i !== -1) this.txRing.splice(i, 1);

        if (this.window < this.windowMax) this.window += 1;

        const rtt = this.link.rtt;
        if (rtt) {
            if (rtt > Channel.RTT_FAST) {
                this.fastRateRounds = 0;
                if (rtt > Channel.RTT_MEDIUM) {
                    this.mediumRateRounds = 0;
                } else {
                    this.mediumRateRounds += 1;
                    if (this.windowMax < Channel.WINDOW_MAX_MEDIUM && this.mediumRateRounds === Channel.FAST_RATE_THRESHOLD) {
                        this.windowMax = Channel.WINDOW_MAX_MEDIUM;
                        this.windowMin = Channel.WINDOW_MIN_LIMIT_MEDIUM;
                    }
                }
            } else {
                this.fastRateRounds += 1;
                if (this.windowMax < Channel.WINDOW_MAX_FAST && this.fastRateRounds === Channel.FAST_RATE_THRESHOLD) {
                    this.windowMax = Channel.WINDOW_MAX_FAST;
                    this.windowMin = Channel.WINDOW_MIN_LIMIT_FAST;
                }
            }
        }

        this.emit('delivered', entry);
    }

    // Called by Link.onPacket() with a decrypted CHANNEL-context envelope.
    _onReceive(envelopeRaw) {
        const parsed = protocol.parse_channel_envelope(envelopeRaw);
        if (!parsed) return;

        if (parsed.sequence < this.nextRxSequence) {
            const windowOverflow = (this.nextRxSequence + Channel.WINDOW_MAX) % Channel.SEQ_MODULUS;
            if (windowOverflow < this.nextRxSequence) {
                if (parsed.sequence > windowOverflow) return;
            } else {
                return;
            }
        }

        if (!this._emplaceRx({ sequence: parsed.sequence, msgtype: parsed.msgtype, data: parsed.data })) return;

        const contiguous = [];
        for (const e of this.rxRing.slice()) {
            if (e.sequence === this.nextRxSequence) {
                contiguous.push(e);
                this.nextRxSequence = (this.nextRxSequence + 1) % Channel.SEQ_MODULUS;
                if (this.nextRxSequence === 0) {
                    for (const e2 of this.rxRing.slice()) {
                        if (e2.sequence === this.nextRxSequence) {
                            contiguous.push(e2);
                            this.nextRxSequence = (this.nextRxSequence + 1) % Channel.SEQ_MODULUS;
                        }
                    }
                }
            }
        }

        for (const e of contiguous) {
            const i = this.rxRing.indexOf(e);
            if (i !== -1) this.rxRing.splice(i, 1);
            this._runHandlers(e.msgtype, e.data);
        }
    }

    _emplaceRx(entry) {
        for (let i = 0; i < this.rxRing.length; i++) {
            const existing = this.rxRing[i];
            if (entry.sequence === existing.sequence) return false;
            if (entry.sequence < existing.sequence && !((this.nextRxSequence - entry.sequence) > 0x7fff)) {
                this.rxRing.splice(i, 0, entry);
                return true;
            }
        }
        this.rxRing.push(entry);
        return true;
    }

    _runHandlers(msgtype, data) {
        for (const handler of this._handlers.slice()) {
            try {
                if (handler(msgtype, data)) return;
            } catch (e) {
                this.emit('error', e);
            }
        }
        this.emit('message', { msgtype, data });
    }

    _shutdown() {
        for (const e of this.txRing) clearTimeout(e.timer);
        this.txRing = [];
        this.rxRing = [];
        this._pendingProofs.clear();
        this._handlers = [];
    }
}
