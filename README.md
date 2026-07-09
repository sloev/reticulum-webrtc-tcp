# reticulum-webrtc-tcp

A JavaScript reimplementation of a subset of the [Reticulum Network Stack](https://reticulum.network/) (RNS) and [LXMF](https://github.com/markqvist/LXMF) wire protocols, using WebRTC data channels as the peer-to-peer transport and public [Nostr](https://nostr.com/) relays for connection signaling. Peers run in the browser or in Node.js and form a sparse mesh; a TCP gateway on the Node.js side bridges raw TCP connections into the mesh, so an unmodified Reticulum node can join it over its standard `TCPClientInterface`.

This is a from-scratch implementation, not a port of or a wrapper around the reference [`rns`](https://github.com/markqvist/Reticulum)/[`lxmf`](https://github.com/markqvist/LXMF) Python packages. The [Compliance](#compliance) section below is a feature-by-feature table with references into both the Python originals and this port, and how each row is verified — either byte-for-byte against captured reference output, or live against a real running Python process. See [Known limitations](#known-limitations) for what this project deliberately doesn't do before relying on it for anything.

**Live demo:** https://sloev.github.io/reticulum-webrtc-tcp/ — the browser peer, built and deployed straight from `browser/` (see [Deploying the demo](#deploying-the-demo)). Open it in two tabs (or send someone the link) to form a mesh link over public Nostr relays and exchange messages.

## Architecture

```
shared/rns/                 Protocol implementation (transport-agnostic)
  crypto.js                   Ed25519 / X25519 / SHA-256 / HKDF / AES-CBC primitives (@noble/*)
  msgpack.js                    Spec-compliant MessagePack encoder/decoder (byte-exact with LXMF's Python umsgpack)
  protocol.js                  Packet framing, announces, Link, Resource, path requests, LXMF message envelopes
  index.js                     Reticulum router (path table, link table), Identity, Destination, Link, Interface base class
  channel.js                    Channel: reliable, windowed message delivery over a Link (interoperates with real RNS.Channel — see Compliance)
  buffer.js                      Buffer: raw byte-stream reader/writer built on top of Channel (interoperates with real RNS.Buffer — see Compliance)
  compression.js                 bz2 compression/decompression for Resource/Buffer data (bzip2-wasm to encode, seek-bzip to decode)
  propagation.js                LXMF propagation nodes: store-and-forward and node-to-node peer sync (interoperate with real LXMRouter — see Compliance)
  stamp.js                       LXMF proof-of-work admission stamps, message and peering-key (LXStamper), verified byte-for-byte
  storage.js                     Node-only filesystem persistence adapter (identity cache, path table, propagation store)

shared/webrtc-rns-interface.js  RNS Interface backed by RTCDataChannel peers (shared by browser + Node)
shared/nostr-signaling.js       Peer discovery and WebRTC offer/answer/ICE exchange over Nostr relays

browser/                    Browser peer: WebRTC glue (webrtc-browser.js) + a chat demo UI (main.js, style.css)
node/
  webrtc-node.js               Node peer: same WebRTC glue, using node-datachannel for RTCPeerConnection
  tcp-gateway.js                RNS Interface that bridges a TCP listener into the mesh
  hdlc.js                        HDLC framing matching RNS.Interfaces.TCPInterface, used by tcp-gateway.js
  index.js                      Entry point: Node WebRTC peer + TCP gateway on port 4242

vite.config.js               Bundles browser/ for the browser (aliases Node builtins used by shared/rns)
test/rns-compliance.test.js  Byte-exact vectors captured from the real `rns` package (node --test)
test/lxmf-compliance.test.js Byte-exact vectors captured from the real `lxmf` package (node --test)
test/storage.test.js        Storage adapter and Reticulum/PropagationNode save/load round-trip tests
test-integration/            Live cross-language checks against real Python rns/lxmf/nomadnet/sbapp processes
```

### Protocol layer (`shared/rns`)

Implements enough of Reticulum's and LXMF's wire formats to interoperate with the real reference implementations, not just with itself. See [Compliance](#compliance) for the full feature table and how each piece is verified. In brief:

- Packet framing, destination hashing, Ed25519-signed announces (with X25519 ratchet keys that rotate on an interval, retaining old ones for a grace period), single-destination encryption, and packet-level delivery proofs.
- `Link` (`shared/rns/index.js`): the core handshake, RTT-adaptive keepalive/stale/timeout timing, `identify()`, small-payload and Resource-based Request/Response.
- `Resource`, `Channel`, and `Buffer`: chunked/reliable/streamed data transfer over a `Link`, including a rate-adaptive request window (grows and shrinks) and bz2 compression in both directions.
- Path requests/responses and multi-hop forwarding of both single-destination packets and established `Link` traffic through an intermediate peer that owns neither endpoint.
- LXMF message envelopes (OPPORTUNISTIC and DIRECT delivery), proof-of-work admission stamps, and propagation nodes (store-and-forward, both this project's own protocol and the wire-compatible one a real LXMF client uses).

### Transport (WebRTC) and signaling (Nostr)

`shared/webrtc-rns-interface.js` defines an `Interface` whose `sendData` writes to every open `RTCDataChannel` (like a shared-medium radio interface transmitting to everyone in range) and whose `sendDataToPeer` writes to one specific peer connection (since, unlike radio, each data channel is individually addressable — the same way a `TCPInterface` can target one specific socket). Received bytes are handed back into the `Reticulum` router along with which peer they came from, for use in path-table-based forwarding (see [Routing](#routing)). `browser/webrtc-browser.js` and `node/webrtc-node.js` extend the interface with the connection setup logic:

- Peers discover each other by publishing a Nostr `kind 30000` parameterized-replaceable event tagged `reticulum-webrtc-mesh` every 60 seconds (`shared/nostr-signaling.js`), and connect to four public relays by default (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`, `wss://nostr.mom`).
- WebRTC offers and answers are exchanged as NIP-04 encrypted direct messages (`kind 4`) addressed by Nostr public key, with each side waiting (up to 3s) for local ICE candidate gathering before sending — one message per offer/answer instead of one per ICE candidate, since some public relays rate-limit high-frequency publishing from a single key.
- `RTCPeerConnection` is configured with a public STUN server (`stun:stun.l.google.com:19302`) so peers behind NAT can discover a reachable address for each other; there is no TURN server, so peers behind strict/symmetric NATs may still fail to connect directly.
- Offer collisions between two peers connecting simultaneously are resolved with the "polite/impolite" perfect-negotiation pattern, decided by comparing Nostr public keys.
- Each peer caps itself to `k = 4` simultaneous outgoing connections, so the mesh stays sparse rather than fully connected.

### Routing

`Reticulum.onPacketReceived` (`shared/rns/index.js`) parses the packet header on every interface and increments the packet's hop count on receipt, matching `RNS.Transport.inbound()`. ANNOUNCE packets are validated, used to update a path table (keyed by destination hash, keeping the lowest hop count and which neighbor it was heard from), and rebroadcast to the peer's other local interfaces with the incremented hop count so presence propagates through the mesh; DATA and PROOF packets addressed to a known local destination or link are delivered locally. A DATA or PROOF packet addressed to a *non-local* single destination is instead forwarded toward the next hop recorded in the path table (`Reticulum._forward`), via `sendDataToPeer` when the interface supports it. A DATA packet addressed to the well-known path-request control destination is answered from the path table. Any incoming byte stream whose first byte has its high bit (`0x80`) set is treated as opaque and relayed unparsed to the other local interfaces — this is how the TCP gateway bridges arbitrary traffic without needing it to be framed as an RNS packet.

Path discovery is hop-count-aware and can find a destination through an intermediate peer, and single-destination messages, LINKREQUEST packets, and an established `Link`'s ongoing traffic (application data, Request/Response, KEEPALIVE, LINKCLOSE) can all be relayed through an intermediate peer that owns neither endpoint (`Reticulum._forward`/`_forwardLinkRequest`/`_forwardLinkTraffic`), verified functionally with an A↔Relay↔B topology where A and B never talk directly.

**A real limitation of this forwarding, found while testing a real end-user client against a real propagation node relayed through this project's own node** (see `test-integration/propagation-node-nomadnet-interop-check.mjs`): `_forward`/`_forwardLinkRequest` never rewrite a packet's `transport_id` when relaying it — real RNS's own transport-enabled nodes do this so downstream nodes know which transport instance a packet is currently routed through. Two other real, transport-enabled RNS processes relaying a Link handshake purely through this project's own node hit real RNS's own `Transport.packet_filter()`, which silently discards a non-announce packet whose `transport_id` doesn't match the receiving node's own transport identity ("in transport for other transport instance"). Announces are unaffected (they're exempt from that filter), and this doesn't affect any topology where this project's own `Reticulum` instance is one of the two `Link` endpoints (every other live check in this project is exactly that shape) — it only surfaces when relaying between two *other* real RNS processes. Not yet fixed; the practical workaround (connecting the two real processes to each other directly, or through a node that's an actual endpoint of at least one side) is what the affected test does.

### TCP gateway and the WebRTC↔TCP bridge

`node/tcp-gateway.js` listens on a TCP port and, for each connected socket, decodes incoming HDLC frames into the RNS packet stream and HDLC-frames outgoing RNS traffic back out to connected sockets, using the same framing as `RNS.Interfaces.TCPInterface` (`node/hdlc.js`: `0x7E` frame delimiter, `0x7D` escape byte, byte-exact tested). This is what lets an unmodified Reticulum node join the mesh over its standard `TCPClientInterface` — every live check in `test-integration/` that spawns a real Python `rns`/`lxmf` process talks to this project through exactly this gateway.

A single Node.js process (`node/index.js`) runs both a WebRTC interface and this TCP gateway on one `Reticulum` instance, so it acts as a bridge between the two transports: a packet arriving on either interface is handled by the same `onPacketReceived`/`_forward`/`_broadcastExcept` routing logic described in [Routing](#routing) above, regardless of which interface it came from or needs to go out on. There's nothing bridge-specific about this — it's the same relaying mechanism any two-interface node uses, just with dissimilar interfaces on each side. This is how a browser-only WebRTC peer and a real Python `rns` process connected over TCP end up able to reach each other: the Node.js bridge process is a normal multi-interface Reticulum node from either side's point of view.

What the bridge does not do: there's no IFAC (interface access code) or other authentication on either interface — whoever connects to the TCP port, or joins the WebRTC mesh, is trusted the same way an unauthenticated `TCPServerInterface`/`AutoInterface` would be in real Reticulum.

## Running it

```bash
npm install
```

Start a Node.js mesh peer with the TCP gateway (listens on `127.0.0.1:4242`):

```bash
npm run gateway
```

Set `RNS_STORAGE_DIR=<path>` to persist the identity cache, path table, and propagation store to disk across restarts (see [Compliance](#compliance)) — otherwise state is in-memory only:

```bash
RNS_STORAGE_DIR=./rns-storage npm run gateway
```

Serve the browser peer with Vite's dev server, then open it in multiple tabs or devices to form additional mesh peers:

```bash
npm run dev
```

Or build a static bundle:

```bash
npm run build
```

No local signaling server is needed — signaling happens over the public Nostr relays configured in `shared/nostr-signaling.js`.

Run the unit test suite (byte-exact vectors, no external processes) with:

```bash
npm test
```

The `test-integration/` scripts are heavier, separate checks that spawn real Python processes (and, for two of them, headless Chromium) — not part of `npm test`. Each requires `pip install --target=<dir> rns lxmf` at minimum; individual scripts note any extra package needed. Set `PYLIBS` to that directory and run:

| Script | npm run | Extra requirements |
|---|---|---|
| `sparse-mesh-check.mjs` | `test:integration` | `npm run dev` running (vite) |
| `lxmf-cross-language-check.mjs` | `test:integration:lxmf` | — |
| `resource-cross-language-check.mjs` | `test:integration:resource` | — |
| `channel-cross-language-check.mjs` | `test:integration:channel` | — |
| `path-request-cross-language-check.mjs` | `test:integration:path-request` | — |
| `lxmf-propagation-cross-language-check.mjs` | `test:integration:lxmf-propagation` | — |
| `lxmf-propagation-peer-sync-cross-language-check.mjs` | `test:integration:lxmf-peer-sync` | — |
| `propagation-client-interop-check.mjs` | `test:integration:propagation-client` | — |
| `propagation-node-nomadnet-interop-check.mjs` | `test:integration:propagation-nomadnet` | `nomadnet` in `PYLIBS` |
| `nomadnet-interop-check.mjs` | `test:integration:nomadnet` | `nomadnet` in `PYLIBS` |
| `sideband-interop-check.mjs` | `test:integration:sideband` | `sbapp` in `PYLIBS` |

```bash
PYLIBS=/path/to/site-packages npm run test:integration:lxmf
```

Two more (`manual-tcp-check.mjs`, `manual-webrtc-chain-check.mjs`) aren't wired into `package.json` — they're superseded by the scripts above but kept as minimal standalone smoke tests; run with `node test-integration/<name>.mjs` directly.

### Browser demo

`browser/index.html` shows your peer's 16-byte destination hash (RID), a copy button, and live mesh status: the number of open WebRTC links and the RIDs of peers you've received an announce from (click one to fill in the destination field). Enter a destination RID and a message and send; this establishes (or reuses) a `Link` to that peer once you've received an announce from their identity (your own identity is announced automatically every 10 seconds), proves your identity to them over it via `Link.identify()`, and sends the message as a reliable `Channel` message — the recipient shows it tagged with your RID once your `identify()` packet has arrived.

## Deploying the demo

`.github/workflows/deploy-pages.yml` builds `browser/` with Vite and publishes it to GitHub Pages on every push to `main` (or manually via "Run workflow"). It builds with `--base=/<repo-name>/` so asset paths resolve correctly under `https://<owner>.github.io/<repo>/`, and installs dependencies with `--ignore-scripts` since the Pages build only needs the browser bundle, not `node-datachannel`'s native binary.

One-time setup for a fork or new repo: in **Settings → Pages**, set **Source** to **GitHub Actions**. After that, pushes to `main` deploy automatically.

## Compliance

This project is a from-scratch reimplementation, checked against the real [`rns`](https://pypi.org/project/rns/) package (v1.3.7) and [`lxmf`](https://pypi.org/project/lxmf/) package (v1.0.1) rather than assumed compatible. It does not join the official Reticulum/LXMF network. The table below is the canonical, current feature-parity checklist; [compliance.md](./compliance.md) is the historical execution log — the phase-by-phase work that got each row here, kept for reference but not updated further.

**Verification methods**, referenced in the "Verified by" column:

- **byte-exact** — a unit test (`test/rns-compliance.test.js`, `test/lxmf-compliance.test.js`) asserts this project's output matches ground-truth bytes captured from a real `rns`/`lxmf` install for a fixed identity/timestamp.
- **live** — a `test-integration/*.mjs` script spawns a real Python `rns`/`lxmf` (and for two scripts, `nomadnet`/`sbapp`) process and confirms genuine interop over real TCP, not just a byte comparison. Named checks refer to `npm run test:integration:<name>` from the table in [Running it](#running-it).
- **functional** — a unit test confirms correct behavior end-to-end (e.g. across a multi-hop topology) without comparing to a captured byte vector, usually because the exact bytes on the wire depend on non-deterministic ordering.

Status: **DONE** (implemented + verified) · **PARTIAL** (implemented with a documented, intentional deviation) · **N/A** (deliberately out of scope, with reason).

### Core wire format & identity

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Packet framing (flags/hops/dest/context) | `RNS/Packet.py` `Packet.pack()/unpack()` | `shared/rns/protocol.js` `packet_pack/packet_unpack` | DONE | byte-exact |
| Identity & destination hashing | `RNS/Identity.py` `full_hash/truncated_hash`, `RNS/Destination.py` `expand_name/hash` | `shared/rns/protocol.js` `identity_hash/destination_hash` | DONE | byte-exact |
| Announces (ratchet, random_hash, Ed25519 sig) | `RNS/Destination.py` `announce()`, `RNS/Identity.py` `validate_announce()` | `shared/rns/protocol.js` `build_announce/validate_announce` | DONE | byte-exact |
| Ratchet rotation and retention | `RNS/Destination.py:85,90,227` `RATCHET_COUNT/RATCHET_INTERVAL/rotate_ratchets()` | `shared/rns/index.js` `Destination._rotateRatchets/saveRatchets/loadRatchets`, `onData` decrypt-candidate order | DONE | unit (rotate-then-decrypt-via-retained-ratchet, `RATCHET_COUNT` trim, save/load round-trip) + live (`test:integration:lxmf`) |
| Single-destination encryption (ratchet + fallback) | `RNS/Identity.py` `encrypt()/decrypt()` | `shared/rns/protocol.js` `build_data/message_decrypt` | DONE | byte-exact |
| Packet delivery proofs (implicit form) | `RNS/Packet.py` `prove()`, `PacketReceipt.validate_proof()` | `shared/rns/protocol.js` `build_packet_proof/validate_packet_proof` | DONE | byte-exact |
| MessagePack byte-compat with `umsgpack` | `RNS/vendor/umsgpack.py` | `shared/rns/msgpack.js` | DONE | byte-exact |
| HDLC TCP framing | `RNS/Interfaces/TCPInterface.py` `HDLC` | `node/hdlc.js` | DONE | byte-exact |

### Link

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Handshake (LINKREQUEST/PROOF/LRRTT), Token encryption, LINKCLOSE | `RNS/Link.py` | `shared/rns/index.js` `Link`, `shared/rns/protocol.js` | DONE | byte-exact + live |
| RTT-adaptive keepalive/stale/timeout state machine | `RNS/Link.py:75–108` (constants), `__watchdog_job`, `__update_keepalive` | `shared/rns/index.js` `Link._watchdogTick/_updateKeepalive/_noteInbound` | DONE | unit (formula + STALE transition/recovery/teardown) + live |
| Hop-scaled establishment timeout | `RNS/Link.py:75,206,284` (`ESTABLISHMENT_TIMEOUT_PER_HOP=6`) | `shared/rns/index.js` `Link` constructor/`fromRequest` | DONE | live |
| `identify()` / `get_remote_identity()` | `RNS/Link.py` `identify()` | `shared/rns/index.js` `Link.identify/getRemoteIdentity` | DONE | live (real `LXMRouter`, real client `/get` sync) |
| Request/Response (single-packet) | `RNS/Link.py` `request()`, `RNS/Destination.py` `register_request_handler()` | `shared/rns/index.js` `Link.request`, `Destination.registerRequestHandler` | DONE | byte-exact + live |
| Request/Response Resource fallback (oversized payloads) | `RNS/Link.py:506` (request), `:844–850` (response) | `shared/rns/index.js` `Link.request/_handleRequest` | DONE | unit + live (real `LXMRouter` oversized `/get` response) |

### Resource / Channel / Buffer

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Resource send/receive, part hashmap, completion proof | `RNS/Resource.py` | `shared/rns/index.js` `Link.sendResource` + `shared/rns/protocol.js` | DONE | byte-exact + live both directions |
| Multi-segment transfers (send + receive), segment size | `RNS/Resource.py:116` `MAX_EFFICIENT_SIZE`, `:274–310` | `shared/rns/protocol.js` `RESOURCE_SEGMENT_MAX_SIZE`, `shared/rns/index.js` `_sendResourceSegment` | DONE | live (real peer reassembles/sends a >1MiB, multi-segment transfer) |
| Rate-adaptive request window: growth + promotion/demotion | `RNS/Resource.py:58–99` (`WINDOW`/`WINDOW_MIN`/`WINDOW_MAX_SLOW`/`WINDOW_MAX_FAST`/`WINDOW_FLEXIBILITY`/`RATE_FAST`/`RATE_VERY_SLOW`), `:900–924` | `shared/rns/index.js` `Link._growResourceWindow/_requestNextResourceParts` | DONE | unit (monotonic window growth) + live |
| Retry-driven window shrink (per-part timeout/retry) | `RNS/Resource.py:612–621` (`PART_TIMEOUT_FACTOR`/`_AFTER_RTT`/`MAX_RETRIES`) | `shared/rns/index.js` `_armResourceRetry/_resourceRetryTick` | PARTIAL — retry timing scales by measured link RTT (floored at 25ms) rather than Python's estimated in-flight rate (`update_eifr()`), to avoid spurious retries on a low-latency loopback link | unit (lossy-bridge recovery-with-shrink, dead-bridge exhaustion-after-`MAX_RETRIES`) |
| HMU (hashmap update), send + receive | `RNS/Resource.py:483–499` `hashmap_update_packet`, `HASHMAP_IS_EXHAUSTED=0xFF`, `ResourceAdvertisement.HASHMAP_MAX_LEN` | `shared/rns/index.js` `_onResourceRequest`/`_onHashmapUpdate`, `shared/rns/protocol.js` `build/parse_resource_hmu`, `RESOURCE_HASHMAP_MAX_LEN` | DONE (both directions) | unit + live (real >74-part sender and receiver each drive a genuine HMU exchange) |
| Incoming bz2 decompression | `RNS/Resource.py` assemble | `shared/rns/compression.js` `bz2_decompress` | DONE | live (real compressed data) |
| Outgoing bz2 compression | `RNS/Resource.py` (compress-if-beneficial, `AUTO_COMPRESS_MAX_SIZE=64MiB`) | `shared/rns/compression.js` `bz2_compress/bz2_compress_if_beneficial` | DONE | byte-exact (matches `bz2.compress()` exactly) + live |
| Channel (envelope, proofs, RTT-adaptive send window) | `RNS/Channel.py` | `shared/rns/channel.js` | DONE | byte-exact + live both directions |
| Buffer (stream reader/writer, compressed chunks) | `RNS/Buffer.py` | `shared/rns/buffer.js` | DONE | live both directions |

### Transport / routing

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Path requests/responses (wire format) | `RNS/Transport.py` `request_path/path_request_handler` (`:2799–2939`) | `shared/rns/index.js` `requestPath/_handlePathRequest` | DONE | byte-exact + live |
| Multi-hop DATA/PROOF forwarding | `RNS/Transport.py` inbound/outbound | `shared/rns/index.js` `_forward` | PARTIAL — simplified single-destination analog, doesn't rewrite `transport_id` when relaying (see [Routing](#routing)) | functional (3-peer test) |
| Multi-hop Link relaying (link table) | `RNS/Transport.py` link_table | `shared/rns/index.js` `_forwardLinkRequest/_forwardLinkTraffic` | PARTIAL — same `transport_id` caveat as above | functional (3-peer test) |
| Path-request throttling (`PATH_REQUEST_MI`) & table expiry (`DESTINATION_TIMEOUT`) | `RNS/Transport.py:83,91,2839` | `shared/rns/index.js` `Reticulum.requestPath/_cleanupPathTable` | DONE | unit + live |
| Transport instance identity + 3-field path requests | `RNS/Transport.py:2811` | `shared/rns/index.js` `Reticulum.transportIdentity`, `protocol.js` `build_path_request` | DONE | byte-exact + live |
| Announce rate table (timestamps, `MAX_RATE_TIMESTAMPS`) | `RNS/Transport.py:96,1890–1911` | `shared/rns/index.js` `Reticulum.announceRateTable` | PARTIAL — mechanism ported, enforcement not (matches RNS's own default-off `announce_rate_target`) | unit |
| Path-request rebroadcast grace & rebroadcast cap | `RNS/Transport.py:77,81–82,3012–3028` | — | N/A — LAN-collision-avoidance timing tuned for slow shared-bandwidth radio links; doesn't affect correctness for a WebRTC/TCP mesh | — |

### LXMF

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Message envelope + signature (OPPORTUNISTIC) | `LXMF/LXMessage.py` `pack()` | `shared/rns/protocol.js` `lxmf_build/lxmf_parse` | DONE | byte-exact + live both directions |
| DIRECT delivery (over a Link; packet or Resource) | `LXMF/LXMessage.py:355–460` (`pack`), `:626–654` (`__as_packet`/`__as_resource`) | `shared/rns/protocol.js` `lxmf_build_direct/lxmf_parse_direct`, `shared/rns/index.js` `Link.sendLXMF` | DONE | byte-exact + live (both directions, both representations) |
| Delivery announce app_data + compression negotiation | `LXMF/LXMRouter.py:985–1000`, `LXMF/LXMessage.py:510–517` | `shared/rns/protocol.js` `lxmf_build_announce_app_data/lxmf_compression_supported` | DONE | byte-exact + live |
| Admission stamps (message) | `LXMF/LXStamper.py` | `shared/rns/stamp.js` | DONE | byte-exact + live |
| Peering-key stamps | `LXMF/LXStamper.py` `generate_peering_key` | `shared/rns/stamp.js` `generate/validate_peering_key` | DONE | byte-exact + live |
| Propagation-node announce app_data (7-element list) | `LXMF/LXMRouter.py:300–318`, `LXMF/LXMF.py:224` | `shared/rns/protocol.js` `lxmf_build_propagation_announce_app_data/lxmf_parse_propagation_announce_app_data` | DONE | byte-exact + live |
| Propagation node store, own client sync (`/get`) | `LXMF/LXMRouter.py` `message_get_request` | `shared/rns/propagation.js` `PropagationNode`, `syncLXMF` | DONE | live (upload + download vs a real node) |
| Propagation node's `/get`, wire-compatible with a real client | `LXMF/LXMRouter.py:1426–1504` `message_get_request` | `shared/rns/propagation.js` `PropagationNode._onRealGetRequest`, `syncFromRealPropagationNode` | DONE | unit + live (`test:integration:propagation-client`: a real `LXMRouter` client syncs from this project's own node) |
| Node-to-node peer sync (`/offer`) | `LXMF/LXMPeer.py`, `LXMRouter.offer_request` | `shared/rns/propagation.js` `syncToPeer/_onOfferRequest` | DONE | live (real node accepts + stores) |
| Real end-user client ↔ real propagation node, through this project | n/a | `test-integration/propagation-node-nomadnet-interop-check.mjs` | PARTIAL — JS-upload/NomadNet-sync direction verified live and repeatably; the NomadNet-send/JS-download direction is implemented against the same `LXMRouter.handle_outbound()`/`process_deferred_stamps()` path NomadNet's own UI uses, and was observed correctly reaching real `LXStamper`'s proof-of-work computation, but wasn't exercised to completion in this environment (real PoW at the node's minimum accepted cost takes several minutes in pure Python here) | live |
| Interop with end-user clients (NomadNet, Sideband), direct delivery | n/a | `test-integration/nomadnet-interop-check.mjs`, `test-integration/sideband-interop-check.mjs` | DONE (both, both directions) | live, against real unmodified clients |
| PAPER delivery method (QR-encoded messages) | `LXMF/LXMessage.py:33,446–456` | — | N/A — no meaningful use over WebRTC/TCP | — |
| IFAC (interface access codes) | `RNS/Interfaces/Interface.py` | — | N/A — private-network access control for shared physical media; see [TCP gateway and the WebRTC↔TCP bridge](#tcp-gateway-and-the-webrtctcp-bridge) | — |

### Persistence & environment

| Feature | Python reference | JS location | Status | Verified by |
|---|---|---|---|---|
| Browser demo identity persistence | n/a (environment adaptation) | `browser/main.js` `loadOrCreateIdentity` (sessionStorage) | DONE | Playwright (reload keeps RID, new tab differs) |
| Known-destinations / identity-cache / path-table persistence | `RNS/Identity.py:101–260` `remember/recall/save_known_destinations` | `shared/rns/storage.js`, `Reticulum.saveState/loadState` | DONE (adaptation — own format, not RNS's on-disk one) | unit |
| Ratchet retention persistence | `RNS/Destination.py:210–243` | `Destination.saveRatchets/loadRatchets` | DONE (adaptation) | unit |
| Propagation store persistence | `LXMF/LXMRouter.py` storagepath handling | `PropagationNode.saveState/loadState` | DONE (adaptation — own format, one file per transient_id in spirit) | unit |
| Radio/serial interfaces (RNode, LoRa, I2P, …) | `RNS/Interfaces/*` | `shared/webrtc-rns-interface.js`, `node/tcp-gateway.js` | N/A — this project's transports are WebRTC + TCP by design | — |

## Known limitations

- `_forward`/`_forwardLinkRequest` don't rewrite `transport_id` when relaying — see [Routing](#routing) for what this does and doesn't affect.
- The Resource receiver's retry-driven window shrink scales its per-part timeout by measured link RTT rather than Python's estimated in-flight transfer rate — see the Compliance table.
- Signaling depends on public Nostr relays; relay operators can observe connection metadata (who is signaling whom, and when) even though offer/answer payloads are NIP-04 encrypted, and any of them may still rate-limit a busy key.
- `node-datachannel` (used for `RTCPeerConnection` in Node) ships prebuilt native binaries per platform; if none is available for your platform/Node version, `npm install` needs to build it from source.
- Identities, the announce/identity cache, links, and propagation node storage are in-memory only by default and are lost on restart — except in Node, where setting `RNS_STORAGE_DIR` persists the identity cache, path table, retained ratchets, and `PropagationNode`'s message store to disk (see [Compliance](#compliance)). Links themselves are never persisted (they're inherently transient); there's no browser-side equivalent beyond the demo's own per-session identity caching.
- The browser UI in `browser/` is a minimal demo for exercising the stack, not a finished chat client.

## License

MIT — see [LICENSE](./LICENSE).
