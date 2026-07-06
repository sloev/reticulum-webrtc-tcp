// RNS.Buffer: a raw byte-stream reader/writer built on top of Channel, using
// its system-reserved MSGTYPE (CHANNEL_MSGTYPE_STREAM_DATA). See protocol.js's
// "RNS.Buffer" section for the wire format (verified byte-for-byte against
// the real `rns` package).
//
// Deviates from real RNS's API shape: instead of Python's RawIOBase/
// BufferedReader/BufferedWriter (which don't have a JS equivalent worth
// depending on stream-browserify for), this exposes a small EventEmitter-
// based reader (`.read(n)`, `'data'`/`'end'` events) and a writer
// (`.write(bytes)`, `.close()`) — the wire format and chunking/EOF semantics
// are what matters for interop, not the local consumption API.
//
// Each outgoing chunk is bz2-compressed if that's smaller (see
// shared/rns/compression.js's bz2_compress_if_beneficial()), matching real
// RNS's own per-chunk compression — and, as always, an incoming compressed
// chunk from a real RNS peer is transparently decompressed the same way.
import * as protocol from './protocol.js';
import { EventEmitter } from 'events';
import { ChannelError } from './channel.js';
import * as compression from './compression.js';

export class RawChannelReader extends EventEmitter {
    constructor(streamId, channel) {
        super();
        this.streamId = streamId;
        this.channel = channel;
        this._buffer = [];
        this._bufferedLength = 0;
        this._eof = false;
        this._handler = (msgtype, data) => this._handleMessage(msgtype, data);
        this.channel.addMessageHandler(this._handler);
    }

    _handleMessage(msgtype, envelopeData) {
        if (msgtype !== protocol.CHANNEL_MSGTYPE_STREAM_DATA) return false;
        const message = protocol.parse_stream_data_message(envelopeData);
        if (!message || message.stream_id !== this.streamId) return false;

        let data = message.data;
        if (message.compressed) {
            try {
                data = compression.bz2_decompress(data, protocol.STREAM_DATA_MAX_CHUNK_LEN);
            } catch (e) {
                this.emit('error', e);
                return true;
            }
        }

        if (data.length > 0) {
            this._buffer.push(data);
            this._bufferedLength += data.length;
        }
        if (message.eof) this._eof = true;

        this.emit('data', data);
        if (this._eof) this.emit('end');
        return true;
    }

    // Bytes currently buffered and not yet consumed via read().
    get readyBytes() {
        return this._bufferedLength;
    }

    // Whether the sender has sent its final, eof-flagged chunk (regardless
    // of whether all preceding buffered bytes have been consumed via
    // read() yet — see `readyBytes` for that).
    get eof() {
        return this._eof;
    }

    // Consumes and returns up to `size` buffered bytes (fewer if that's all
    // that's available), or null if nothing is buffered and EOF hasn't been
    // reached yet.
    read(size) {
        if (this._bufferedLength === 0) return this._eof ? new Uint8Array(0) : null;

        const whole = this._buffer.length === 1 ? this._buffer[0] : concatChunks(this._buffer, this._bufferedLength);
        const take = whole.slice(0, size);
        const rest = whole.slice(size);

        this._buffer = rest.length > 0 ? [rest] : [];
        this._bufferedLength = rest.length;

        return take;
    }

    close() {
        this.channel.removeMessageHandler(this._handler);
    }
}

function concatChunks(chunks, totalLength) {
    const out = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.length;
    }
    return out;
}

export class RawChannelWriter {
    constructor(streamId, channel) {
        this.streamId = streamId;
        this.channel = channel;
        this._eof = false;
        this._maxChunkLen = protocol.STREAM_DATA_MAX_LEN;
    }

    // Sends up to one chunk's worth of `data` (a Uint8Array), truncating to
    // this writer's max chunk length if it's larger — matching
    // RawChannelWriter.write()'s single-chunk-per-call contract in real RNS.
    // Compresses the chunk first if that's smaller (matching real RNS's own
    // per-chunk compression), but always returns the number of *uncompressed*
    // input bytes consumed (not the compressed size actually sent), since
    // that's what callers use to track their offset into the source data —
    // matching real RawChannelWriter.write()'s own return-value contract.
    // Throws if the channel isn't ready to send (ME_LINK_NOT_READY) rather
    // than swallowing it, since callers here are expected to check
    // `channel.isReadyToSend()` first.
    async write(data) {
        const chunk = data.length > this._maxChunkLen ? data.slice(0, this._maxChunkLen) : data;
        const { data: sendData, compressed } = await compression.bz2_compress_if_beneficial(chunk);
        const message = protocol.build_stream_data_message(this.streamId, sendData, this._eof, compressed);
        try {
            this.channel.send(protocol.CHANNEL_MSGTYPE_STREAM_DATA, message);
        } catch (e) {
            if (e instanceof ChannelError && e.type === 'ME_LINK_NOT_READY') return 0;
            throw e;
        }
        return chunk.length;
    }

    // Marks the stream as finished and sends a final, empty, eof-flagged
    // chunk. Waits (polling, like real RNS's Buffer.close()) for the channel
    // to have room to send if it's currently at its window limit.
    async close({ timeoutMs = 15000, pollMs = 20 } = {}) {
        const deadline = Date.now() + timeoutMs;
        while (!this.channel.isReadyToSend() && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, pollMs));
        }
        this._eof = true;
        await this.write(new Uint8Array(0));
    }
}

export function createReader(streamId, channel) {
    return new RawChannelReader(streamId, channel);
}

export function createWriter(streamId, channel) {
    return new RawChannelWriter(streamId, channel);
}

export function createBidirectionalBuffer(receiveStreamId, sendStreamId, channel) {
    return {
        reader: new RawChannelReader(receiveStreamId, channel),
        writer: new RawChannelWriter(sendStreamId, channel),
    };
}

export { ChannelError };
