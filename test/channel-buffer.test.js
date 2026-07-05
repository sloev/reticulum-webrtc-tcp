// RNS.Channel/RNS.Buffer: wire-format ground truth captured from the real
// `rns` package (RNS.Channel.Envelope.pack()/RNS.Buffer.StreamDataMessage.
// pack(), called directly — no live process needed, since these are pure
// struct-packing functions), plus in-process end-to-end tests of this
// project's Channel/Buffer built on top of two independently-established
// Links (same Bridge-interface pattern as the rest of this suite).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Identity, Destination, Reticulum, Interface, Link } from '../shared/rns/index.js';
import * as protocol from '../shared/rns/protocol.js';
import * as crypto from '../shared/rns/crypto.js';
import { ChannelError } from '../shared/rns/channel.js';
import * as RnsBuffer from '../shared/rns/buffer.js';

test('Channel envelope matches RNS.Channel.Envelope.pack() byte-for-byte', () => {
  const raw = protocol.build_channel_envelope(0x0001, 42, new TextEncoder().encode('hello world'));
  assert.equal(crypto.bytesToHex(raw), '0001002a000b68656c6c6f20776f726c64');

  const parsed = protocol.parse_channel_envelope(raw);
  assert.equal(parsed.msgtype, 0x0001);
  assert.equal(parsed.sequence, 42);
  assert.equal(new TextDecoder().decode(parsed.data), 'hello world');
});

test('StreamDataMessage matches RNS.Buffer.StreamDataMessage.pack() byte-for-byte', () => {
  const noEof = protocol.build_stream_data_message(5, new TextEncoder().encode('chunkdata'), false, false);
  assert.equal(crypto.bytesToHex(noEof), '00056368756e6b64617461');

  const withEof = protocol.build_stream_data_message(5, new TextEncoder().encode('chunkdata'), true, false);
  assert.equal(crypto.bytesToHex(withEof), '80056368756e6b64617461');

  const maxIdEmptyEof = protocol.build_stream_data_message(0x3fff, new Uint8Array(0), true, false);
  assert.equal(crypto.bytesToHex(maxIdEmptyEof), 'bfff');

  const parsed = protocol.parse_stream_data_message(withEof);
  assert.equal(parsed.stream_id, 5);
  assert.equal(parsed.eof, true);
  assert.equal(parsed.compressed, false);
  assert.equal(new TextDecoder().decode(parsed.data), 'chunkdata');

  // An envelope wrapping a StreamDataMessage, exactly as Buffer would send it
  // over a Channel — msgtype 0xff00 (SMT_STREAM_DATA), sequence 7.
  const wrapped = protocol.build_channel_envelope(protocol.CHANNEL_MSGTYPE_STREAM_DATA, 7, noEof);
  assert.equal(crypto.bytesToHex(wrapped), 'ff000007000b00056368756e6b64617461');
});

test('STREAM_DATA_MAX_LEN/OVERHEAD match RNS.Buffer.StreamDataMessage (MAX_DATA_LEN=423, OVERHEAD=8)', () => {
  assert.equal(protocol.STREAM_DATA_OVERHEAD, 8);
  assert.equal(protocol.STREAM_DATA_MAX_LEN, 423);
});

function makeLinkedPair() {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();
  class Bridge extends Interface {
    connect() {}
    sendData(data) { setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0); }
  }
  const ifaceA = new Bridge('A');
  const ifaceB = new Bridge('B');
  ifaceA.other = ifaceB;
  ifaceB.other = ifaceA;
  rnsA.addInterface(ifaceA);
  rnsB.addInterface(ifaceB);
  return { rnsA, rnsB };
}

async function establishLinkPair() {
  const { rnsA, rnsB } = makeLinkedPair();
  const responderIdentity = Identity.create();
  const responderDest = new Destination(rnsB, responderIdentity, Destination.IN, Destination.SINGLE, 'test', 'channel');
  const outDest = new Destination(rnsA, responderIdentity, Destination.OUT, Destination.SINGLE, 'test', 'channel');
  outDest.hash = responderDest.hash;

  const responderLinkPromise = new Promise((resolve) => responderDest.on('link', resolve));
  const initiatorLink = new Link(rnsA, outDest);
  await new Promise((resolve) => initiatorLink.once('established', resolve));

  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  return { initiatorLink, responderLink };
}

test('Channel.send()/addMessageHandler() reliably deliver several messages in order, with delivery proofs and a growing window', async () => {
  const { initiatorLink, responderLink } = await establishLinkPair();

  const initiatorChannel = initiatorLink.getChannel();
  const responderChannel = responderLink.getChannel();

  const received = [];
  responderChannel.addMessageHandler((msgtype, data) => {
    received.push({ msgtype, text: new TextDecoder().decode(data) });
    return true;
  });

  const delivered = [];
  initiatorChannel.on('delivered', (entry) => delivered.push(entry.sequence));

  for (let i = 0; i < 6; i++) {
    while (!initiatorChannel.isReadyToSend()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    initiatorChannel.send(0x0001, new TextEncoder().encode(`msg-${i}`));
  }

  await new Promise((resolve) => {
    const check = () => (delivered.length === 6 ? resolve() : setTimeout(check, 10));
    check();
  });

  assert.deepEqual(delivered, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(received.map((r) => r.text), ['msg-0', 'msg-1', 'msg-2', 'msg-3', 'msg-4', 'msg-5']);
  assert.ok(received.every((r) => r.msgtype === 0x0001));
  assert.equal(initiatorChannel.txRing.length, 0);
  assert.ok(initiatorChannel.window >= 2);

  initiatorLink.close();
});

test('Channel.send() throws ME_LINK_NOT_READY once the window is full, and ME_TOO_BIG for an oversized message', async () => {
  const { initiatorLink } = await establishLinkPair();
  const channel = initiatorLink.getChannel();

  assert.throws(() => channel.send(0x0002, new Uint8Array(protocol.LINK_MDU)), (e) => e instanceof ChannelError && e.type === 'ME_TOO_BIG');

  // Exhaust the initial window (2) without a peer to deliver proofs back.
  channel.send(0x0001, new Uint8Array(1));
  channel.send(0x0001, new Uint8Array(1));
  assert.equal(channel.isReadyToSend(), false);
  assert.throws(() => channel.send(0x0001, new Uint8Array(1)), (e) => e instanceof ChannelError && e.type === 'ME_LINK_NOT_READY');

  channel._shutdown();
  initiatorLink.close();
});

test('Channel retries and eventually delivers a message whose first send is dropped in transit', async () => {
  const rnsA = new Reticulum();
  const rnsB = new Reticulum();
  let dropNextChannelPacket = false;
  class Bridge extends Interface {
    connect() {}
    sendData(data) {
      const packet = protocol.packet_unpack(data);
      if (packet && packet.context === protocol.CONTEXT_CHANNEL && dropNextChannelPacket) {
        dropNextChannelPacket = false;
        return; // simulate the packet being lost
      }
      setTimeout(() => this.other.rns.onPacketReceived(data, this.other), 0);
    }
  }
  const ifaceA = new Bridge('A');
  const ifaceB = new Bridge('B');
  ifaceA.other = ifaceB;
  ifaceB.other = ifaceA;
  rnsA.addInterface(ifaceA);
  rnsB.addInterface(ifaceB);

  const responderIdentity = Identity.create();
  const responderDest = new Destination(rnsB, responderIdentity, Destination.IN, Destination.SINGLE, 'test', 'channel-retry');
  const outDest = new Destination(rnsA, responderIdentity, Destination.OUT, Destination.SINGLE, 'test', 'channel-retry');
  outDest.hash = responderDest.hash;

  const responderLinkPromise = new Promise((resolve) => responderDest.on('link', resolve));
  const initiatorLink = new Link(rnsA, outDest);
  await new Promise((resolve) => initiatorLink.once('established', resolve));
  const responderLink = await responderLinkPromise;
  await new Promise((resolve) => (responderLink.status === Link.ACTIVE ? resolve() : responderLink.once('established', resolve)));

  const responderChannel = responderLink.getChannel();
  const initiatorChannel = initiatorLink.getChannel();

  const receivedText = new Promise((resolve) => {
    responderChannel.addMessageHandler((msgtype, data) => {
      resolve(new TextDecoder().decode(data));
      return true;
    });
  });

  dropNextChannelPacket = true;
  const entry = initiatorChannel.send(0x0003, new TextEncoder().encode('resend me'));

  assert.equal(await receivedText, 'resend me');
  assert.ok(entry.tries >= 2, `expected at least one retry, got tries=${entry.tries}`);

  initiatorLink.close();
});

test('Buffer round-trips a multi-chunk stream end to end, split across many write() calls and terminated with eof', async () => {
  const { initiatorLink, responderLink } = await establishLinkPair();
  const writerChannel = initiatorLink.getChannel();
  const readerChannel = responderLink.getChannel();

  const streamId = 1;
  const writer = RnsBuffer.createWriter(streamId, writerChannel);
  const reader = RnsBuffer.createReader(streamId, readerChannel);

  const payload = crypto.randomBytes(3000); // several chunks at STREAM_DATA_MAX_LEN=423
  const chunks = [];
  reader.on('data', (d) => chunks.push(d));
  const ended = new Promise((resolve) => reader.once('end', resolve));

  let offset = 0;
  while (offset < payload.length) {
    while (!writerChannel.isReadyToSend()) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const sent = await writer.write(payload.slice(offset));
    offset += sent;
  }
  await writer.close();
  await ended;

  const reassembled = crypto.concat(...chunks);
  assert.equal(crypto.bytesToHex(reassembled), crypto.bytesToHex(payload));
  assert.equal(reader.eof, true);

  reader.close();
  initiatorLink.close();
});
