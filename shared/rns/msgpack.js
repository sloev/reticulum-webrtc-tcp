// A small, spec-compliant MessagePack encoder/decoder matching the exact
// format choices of RNS's vendored `umsgpack` (see RNS/vendor/umsgpack.py):
// floats always encode as float64 (0xcb), never the size-optimized ints that
// general-purpose JS msgpack libraries (like msgpackr) substitute for
// whole-number floats, and empty maps/short collections use the compact
// fixmap/fixarray forms rather than the wider map16/array16 forms. LXMF's
// message hash and signature are computed over these exact packed bytes, so
// byte-for-byte compatibility with the reference implementation matters here
// in a way it wouldn't for a general-purpose serialization format.
//
// Supports the msgpack types LXMF actually uses: nil, bool, int (fixint/
// int8-64/uint8-64), float64, str (fixstr/str8-32), bin (bin8-32), array
// (fixarray/array16-32), and map (fixmap/map16-32) with string or integer
// keys. Not implemented: ext types, float32, str/bin/array/map sizes beyond
// 32-bit length prefixes.

// Wrap a JS number to force float64 encoding even when it's a whole number
// (msgpack has no separate "float" primitive type to infer from, unlike
// Python, where a value's float-vs-int-ness is part of its runtime type).
export class Float64 {
    constructor(value) { this.value = value; }
}

export function pack(value) {
    const out = [];
    writeValue(value, out);
    return Uint8Array.from(out);
}

function writeValue(value, out) {
    if (value === null || value === undefined) { out.push(0xc0); return; }
    if (value === false) { out.push(0xc2); return; }
    if (value === true) { out.push(0xc3); return; }
    if (value instanceof Float64) { writeFloat64(value.value, out); return; }
    if (typeof value === 'number') {
        if (Number.isInteger(value)) writeInt(value, out);
        else writeFloat64(value, out);
        return;
    }
    if (typeof value === 'string') { writeString(value, out); return; }
    if (value instanceof Uint8Array) { writeBinary(value, out); return; }
    if (Array.isArray(value)) { writeArray(value, out); return; }
    if (typeof value === 'object') { writeMap(value, out); return; }
    throw new Error(`msgpack: unsupported value type ${typeof value}`);
}

function pushBE(out, byteLength, num) {
    for (let shift = (byteLength - 1) * 8; shift >= 0; shift -= 8) {
        out.push((num >>> shift) & 0xff);
    }
}

function writeInt(value, out) {
    if (value >= 0) {
        if (value < 128) { out.push(value); }
        else if (value < 0x100) { out.push(0xcc, value); }
        else if (value < 0x10000) { out.push(0xcd); pushBE(out, 2, value); }
        else if (value < 0x100000000) { out.push(0xce); pushBE(out, 4, value); }
        else { out.push(0xcf); pushBE(out, 4, Math.floor(value / 0x100000000)); pushBE(out, 4, value >>> 0); }
    } else {
        if (value >= -32) { out.push(value & 0xff); }
        else if (value >= -0x80) { out.push(0xd0, value & 0xff); }
        else if (value >= -0x8000) { out.push(0xd1); pushBE(out, 2, value & 0xffff); }
        else if (value >= -0x80000000) { out.push(0xd2); pushBE(out, 4, value >>> 0); }
        else {
            const big = BigInt(value);
            out.push(0xd3);
            pushBE(out, 4, Number((big >> 32n) & 0xffffffffn));
            pushBE(out, 4, Number(big & 0xffffffffn));
        }
    }
}

function writeFloat64(value, out) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, false);
    out.push(0xcb, ...new Uint8Array(buf));
}

function writeString(value, out) {
    const bytes = new TextEncoder().encode(value);
    const len = bytes.length;
    if (len < 32) out.push(0xa0 | len);
    else if (len < 0x100) out.push(0xd9, len);
    else if (len < 0x10000) { out.push(0xda); pushBE(out, 2, len); }
    else { out.push(0xdb); pushBE(out, 4, len); }
    out.push(...bytes);
}

function writeBinary(bytes, out) {
    const len = bytes.length;
    if (len < 0x100) out.push(0xc4, len);
    else if (len < 0x10000) { out.push(0xc5); pushBE(out, 2, len); }
    else { out.push(0xc6); pushBE(out, 4, len); }
    out.push(...bytes);
}

function writeArray(arr, out) {
    const len = arr.length;
    if (len < 16) out.push(0x90 | len);
    else if (len < 0x10000) { out.push(0xdc); pushBE(out, 2, len); }
    else { out.push(0xdd); pushBE(out, 4, len); }
    for (const item of arr) writeValue(item, out);
}

function writeMap(obj, out) {
    const entries = obj instanceof Map ? Array.from(obj.entries()) : Object.entries(obj);
    const len = entries.length;
    if (len < 16) out.push(0x80 | len);
    else if (len < 0x10000) { out.push(0xde); pushBE(out, 2, len); }
    else { out.push(0xdf); pushBE(out, 4, len); }
    for (const [k, v] of entries) {
        writeValue(k, out);
        writeValue(v, out);
    }
}

export function unpack(bytes) {
    const reader = { bytes, offset: 0 };
    return readValue(reader);
}

function readByte(reader) {
    return reader.bytes[reader.offset++];
}

function readBE(reader, byteLength) {
    let value = 0;
    for (let i = 0; i < byteLength; i++) value = value * 256 + readByte(reader);
    return value;
}

function readBytes(reader, length) {
    const slice = reader.bytes.slice(reader.offset, reader.offset + length);
    reader.offset += length;
    return slice;
}

function readValue(reader) {
    const tag = readByte(reader);

    if (tag <= 0x7f) return tag; // positive fixint
    if (tag >= 0xe0) return tag - 0x100; // negative fixint
    if ((tag & 0xf0) === 0x80) return readMap(reader, tag & 0x0f);
    if ((tag & 0xf0) === 0x90) return readArray(reader, tag & 0x0f);
    if ((tag & 0xe0) === 0xa0) return readString(reader, tag & 0x1f);

    switch (tag) {
        case 0xc0: return null;
        case 0xc2: return false;
        case 0xc3: return true;
        case 0xc4: return readBytes(reader, readBE(reader, 1));
        case 0xc5: return readBytes(reader, readBE(reader, 2));
        case 0xc6: return readBytes(reader, readBE(reader, 4));
        case 0xca: { const v = new DataView(sliceBuffer(reader, 4)).getFloat32(0, false); return v; }
        case 0xcb: { const v = new DataView(sliceBuffer(reader, 8)).getFloat64(0, false); return v; }
        case 0xcc: return readBE(reader, 1);
        case 0xcd: return readBE(reader, 2);
        case 0xce: return readBE(reader, 4);
        case 0xcf: return readUBigBE(reader, 8);
        case 0xd0: { const v = readBE(reader, 1); return v >= 0x80 ? v - 0x100 : v; }
        case 0xd1: { const v = readBE(reader, 2); return v >= 0x8000 ? v - 0x10000 : v; }
        case 0xd2: { const v = readBE(reader, 4); return v >= 0x80000000 ? v - 0x100000000 : v; }
        case 0xd3: return readSBigBE(reader, 8);
        case 0xd9: return readString(reader, readBE(reader, 1));
        case 0xda: return readString(reader, readBE(reader, 2));
        case 0xdb: return readString(reader, readBE(reader, 4));
        case 0xdc: return readArray(reader, readBE(reader, 2));
        case 0xdd: return readArray(reader, readBE(reader, 4));
        case 0xde: return readMap(reader, readBE(reader, 2));
        case 0xdf: return readMap(reader, readBE(reader, 4));
        default: throw new Error(`msgpack: unsupported tag 0x${tag.toString(16)}`);
    }
}

function sliceBuffer(reader, length) {
    const bytes = readBytes(reader, length);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function readUBigBE(reader, byteLength) {
    let value = 0n;
    for (let i = 0; i < byteLength; i++) value = value * 256n + BigInt(readByte(reader));
    return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function readSBigBE(reader, byteLength) {
    const bytes = readBytes(reader, byteLength);
    let value = 0n;
    for (const b of bytes) value = (value << 8n) | BigInt(b);
    if (bytes[0] & 0x80) value -= 1n << (8n * BigInt(byteLength));
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value;
}

function readString(reader, length) {
    return new TextDecoder().decode(readBytes(reader, length));
}

function readArray(reader, length) {
    const arr = [];
    for (let i = 0; i < length; i++) arr.push(readValue(reader));
    return arr;
}

function readMap(reader, length) {
    const obj = {};
    for (let i = 0; i < length; i++) {
        const key = readValue(reader);
        obj[key] = readValue(reader);
    }
    return obj;
}
