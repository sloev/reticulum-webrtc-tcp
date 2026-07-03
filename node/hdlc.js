// HDLC-style framing matching Reticulum's TCPInterface (RNS/Interfaces/TCPInterface.py,
// class HDLC): frames are delimited by 0x7E, with 0x7D as an escape byte. This is what
// lets tcp-gateway.js interoperate with a real Reticulum node's TCP interface instead of
// piping raw, unframed bytes over a byte stream that doesn't preserve message boundaries.
const FLAG = 0x7e;
const ESC = 0x7d;
const ESC_MASK = 0x20;

export function hdlcFrame(data) {
  const escaped = [];
  for (const byte of data) {
    if (byte === ESC) escaped.push(ESC, ESC ^ ESC_MASK);
    else if (byte === FLAG) escaped.push(ESC, FLAG ^ ESC_MASK);
    else escaped.push(byte);
  }
  return Buffer.from([FLAG, ...escaped, FLAG]);
}

function hdlcUnescape(frame) {
  const out = [];
  for (let i = 0; i < frame.length; i++) {
    if (frame[i] === ESC && i + 1 < frame.length) {
      out.push(frame[i + 1] ^ ESC_MASK);
      i++;
    } else {
      out.push(frame[i]);
    }
  }
  return Buffer.from(out);
}

// Incrementally decodes HDLC frames out of a TCP byte stream. TCP doesn't
// preserve message boundaries, so incoming chunks may contain a partial
// frame, exactly one frame, or several — this accumulates a buffer across
// calls to push() the same way TCPInterface.read_loop() does.
export class HdlcFrameDecoder {
  constructor() {
    this.buffer = Buffer.alloc(0);
  }

  // Feeds a chunk of incoming bytes; returns an array (possibly empty) of
  // complete, unescaped frames found so far.
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames = [];

    for (;;) {
      const start = this.buffer.indexOf(FLAG);
      if (start === -1) break;
      const end = this.buffer.indexOf(FLAG, start + 1);
      if (end === -1) break;

      const raw = this.buffer.subarray(start + 1, end);
      // Leave the trailing flag in place: it doubles as the opening flag of
      // the next frame when frames are sent back-to-back.
      this.buffer = this.buffer.subarray(end);

      if (raw.length > 0) frames.push(hdlcUnescape(raw));
    }

    return frames;
  }
}
