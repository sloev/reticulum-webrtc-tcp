# reticulum-webrtc-tcp

A JavaScript reimplementation of a subset of the [Reticulum Network Stack](https://reticulum.network/) (RNS) wire protocol, using WebRTC data channels as the peer-to-peer transport and public [Nostr](https://nostr.com/) 
relays for connection signaling. Peers run in the browser or in Node.js and form a sparse mesh; a TCP gateway on the Node.js side bridges raw TCP connections into the mesh.

This is a from-scratch implementation, not a port of or a wrapper around the reference [`rns`](https://github.com/markqvist/Reticulum) Python implementation. Packet framing, identity/destination hashing, announces, single-destination encryption, packet-level delivery proofs, the core `Link` handshake, path request/response discovery, small-payload `Link` Request/Response, single-packet LXMF messages, and LXMF's proof-of-work admission stamp algorithm are now verified byte-for-byte against the real `rns`/`lxmf` packages. Single-destination messages and `Link`s (including everything that flows over one — application data, Request/Response, KEEPALIVE, LINKCLOSE) can now both be relayed multiple hops through an intermediate peer that owns neither endpoint. Payloads too large for a single packet can be sent as a `Resource`, and this is now genuinely interoperable with the real `rns` package's `RNS.Resource` in both directions (confirmed against a live Python process — see [Compliance](#compliance)) — the one gap is compression, which isn't implemented, so a real sender must not compress (which it won't, automatically, for high-entropy data). `Channel` (reliable, windowed message delivery over a `Link`) and `Buffer` (a raw byte-stream reader/writer built on top of `Channel`) are now implemented too, and are also genuinely interoperable with real `RNS.Channel`/`RNS.Buffer` in both directions (confirmed live, same as `Resource`) — again modulo compression, which this project's `Buffer` writer never uses. An LXMF message can also be stored on a propagation node for later pickup when the recipient isn't directly reachable; the *upload* half of this is confirmed to work against a real `LXMF.LXMRouter` propagation node, though *downloading*/syncing from one isn't, and this project's own `PropagationNode` (for two peers both running this codebase) isn't wire-compatible with real LXMF's peer-to-peer node sync. It still does not fully interoperate with the official Reticulum network, official LXMF clients (Sideband, NomadNet), or LXMF propagation nodes in general. See [Compliance](#compliance) and [Known limitations](#known-limitations) before relying on it for anything.

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
  propagation.js                LXMF propagation nodes: store-and-forward (upload interoperates with real LXMRouter — see Compliance)
  stamp.js                       LXMF proof-of-work admission stamps (LXStamper), verified byte-for-byte

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
```

### Protocol layer (`shared/rns`)

Implements enough of Reticulum's wire format to interoperate between the peers in this repo. The pieces below are verified byte-for-byte against the real `rns` package (see [Compliance](#compliance)):

- Packet framing (flags byte, hop count, 16-byte destination hash, context byte, payload) matching Reticulum's on-wire layout.
- Destination hashing: `SHA-256(name_hash || identity_hash)`, where `identity_hash = SHA-256(identity_public_key)[:16]`, each truncated to 16 bytes.
- Announces: Ed25519-signed packets that broadcast an identity's public key and X25519 ratchet key; peers cache these to know who they can talk to.
- Single-destination data: X25519 ECDH with the announced ratchet key (or the destination's primary key, if no ratchet is known), HKDF-derived AES-256-CBC key with PKCS7 padding, and HMAC-SHA256 authentication.
- `Link` (`shared/rns/index.js`): the core handshake — LINKREQUEST (ephemeral X25519 + Ed25519 keys, MTU/mode signalling), the responder's Ed25519-signed PROOF, the ECDH+HKDF handshake keyed by the link ID, and per-link Token-encrypted DATA/LRRTT/KEEPALIVE/LINKCLOSE packets.
- `Link.request()`/`Destination.registerRequestHandler()`: small-payload Request/Response over a link (msgpack `[timestamp, request_path_hash, data]` / `[request_id, response_data]`, where `request_id` is the packed REQUEST packet's own truncated hash — computed identically by both sides since the ciphertext doesn't change in transit).
- Path requests/responses (`shared/rns/index.js`'s `Reticulum.requestPath`/`_handlePathRequest`): the well-known `rnstransport.path.request` control destination, per-hop-incremented hop counts on every received packet, a path table of the lowest hop count seen to each destination, and answering a path request either with a fresh signed announce (if the destination is local) or a cached one (if only known via another peer).
- Multi-hop forwarding for single-destination DATA/PROOF packets (`Reticulum._forward`): a packet addressed to a destination that isn't local gets relayed toward the next hop recorded in the path table, via `Interface.sendDataToPeer()` if the interface can address one specific neighbor (WebRTC, the TCP gateway) or a broadcast otherwise.

Not yet verified or compliant:

- `Link`'s exact RTT-adaptive keepalive/stale/timeout state machine (this uses simple fixed intervals instead — see [Compliance](#compliance)).
- `Resource`'s full rate-adaptive windowed transfer: implemented with a fixed-size request window (rather than one that ramps up on a fast link) and no compression, and interoperates with a real `RNS.Resource` peer in both directions (see [Compliance](#compliance)). `Channel`/`Buffer` (`shared/rns/channel.js`, `shared/rns/buffer.js`) *are* implemented, including the RTT-adaptive send window, and also interoperate with real `RNS.Channel`/`RNS.Buffer` in both directions (see [Compliance](#compliance)) — the gap there is the same as `Resource`'s: no compression.
- LXMF propagation nodes: store-and-forward and proof-of-work admission stamps exist (`shared/rns/propagation.js`, `shared/rns/stamp.js`). Uploading a message to a real `LXMF.LXMRouter` propagation node works (confirmed against a live instance — a real stamp computed at the node's own required cost is accepted, and the message is stored). Node-to-node peer sync (`LXMPeer`'s "/offer" protocol) isn't implemented, and downloading/syncing from a real propagation node isn't either (see [Compliance](#compliance) for why).

### Transport (WebRTC) and signaling (Nostr)

`shared/webrtc-rns-interface.js` defines an `Interface` whose `sendData` writes to every open `RTCDataChannel` (like a shared-medium radio interface transmitting to everyone in range) and whose `sendDataToPeer` writes to one specific peer connection (since, unlike radio, each data channel is individually addressable — the same way a `TCPInterface` can target one specific socket). Received bytes are handed back into the `Reticulum` router along with which peer they came from, for use in path-table-based forwarding (see [Routing](#routing)). `browser/webrtc-browser.js` and `node/webrtc-node.js` extend the interface with the connection setup logic:

- Peers discover each other by publishing a Nostr `kind 30000` parameterized-replaceable event tagged `reticulum-webrtc-mesh` every 60 seconds (`shared/nostr-signaling.js`), and connect to four public relays by default (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`, `wss://nostr.mom`).
- WebRTC offers and answers are exchanged as NIP-04 encrypted direct messages (`kind 4`) addressed by Nostr public key, with each side waiting (up to 3s) for local ICE candidate gathering before sending — one message per offer/answer instead of one per ICE candidate, since some public relays rate-limit high-frequency publishing from a single key.
- `RTCPeerConnection` is configured with a public STUN server (`stun:stun.l.google.com:19302`) so peers behind NAT can discover a reachable address for each other; there is no TURN server, so peers behind strict/symmetric NATs may still fail to connect directly.
- Offer collisions between two peers connecting simultaneously are resolved with the "polite/impolite" perfect-negotiation pattern, decided by comparing Nostr public keys.
- Each peer caps itself to `k = 4` simultaneous outgoing connections, so the mesh stays sparse rather than fully connected.

### Routing

`Reticulum.onPacketReceived` (`shared/rns/index.js`) parses the packet header on every interface and increments the packet's hop count on receipt, matching `RNS.Transport.inbound()`. ANNOUNCE packets are validated, used to update a path table (keyed by destination hash, keeping the lowest hop count and which neighbor it was heard from), and rebroadcast to the peer's other local interfaces with the incremented hop count so presence propagates through the mesh; DATA and PROOF packets addressed to a known local destination or link are delivered locally. A DATA or PROOF packet addressed to a *non-local* single destination is instead forwarded toward the next hop recorded in the path table (`Reticulum._forward`), via `sendDataToPeer` when the interface supports it. A DATA packet addressed to the well-known path-request control destination is answered from the path table (see [Compliance](#compliance)). Any incoming byte stream whose first byte has its high bit (`0x80`) set is treated as opaque and relayed unparsed to the other local interfaces — this is how the TCP gateway bridges arbitrary traffic without needing it to be framed as an RNS packet.

Path discovery is hop-count-aware and can find a destination through an intermediate peer, and single-destination messages can now actually be delivered across those hops too (both verified in `test/rns-compliance.test.js` with an A↔Relay↔B topology where A and B never talk directly). What's still not forwarded: LINKREQUEST packets and an established `Link`'s ongoing traffic — relaying those through an intermediate peer needs a separate "link table" (built while relaying the original LINKREQUEST, so the eventual PROOF and later packets know how to route back) that isn't implemented — see [Compliance](#compliance).

### TCP gateway

`node/tcp-gateway.js` listens on a TCP port and, for each connected socket, decodes incoming HDLC frames into the RNS packet stream and HDLC-frames outgoing RNS traffic back out to all connected sockets, using the same framing as `RNS.Interfaces.TCPInterface` (`node/hdlc.js`: `0x7E` frame delimiter, `0x7D` escape byte). This is what lets the gateway bridge into a real Reticulum node's TCP interface, rather than just piping raw bytes between WebRTC peers running this same codebase.

## Running it

```bash
npm install
```

Start a Node.js mesh peer with the TCP gateway (listens on `127.0.0.1:4242`):

```bash
npm run gateway
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

Run the compliance test suite with:

```bash
npm test
```

There's also a heavier, separate integration check (not part of `npm test`, since it spawns real subprocesses/browsers and takes much longer) in `test-integration/sparse-mesh-check.mjs`. It spins up a sparse, mixed-transport mesh — two real Python `rns` processes, two Node.js TCP/WebRTC bridge processes, and two WebRTC-only browser peers (via headless Chromium/Playwright), wired sparsely so no node has a direct link to a node more than one hop away — and confirms an announce from one Python node reaches the other across every hop and transport. Requires `pip install rns` and a running `npm run dev` (vite) server:

```bash
PYLIBS=/path/to/site-packages npm run test:integration
```

There's also `test-integration/lxmf-cross-language-check.mjs`, which has a real Python `lxmf`/`rns` process and this JS stack exchange genuine signed LXMF messages over real TCP in both directions. Requires `pip install rns lxmf`:

```bash
PYLIBS=/path/to/site-packages npm run test:integration:lxmf
```

`test-integration/resource-cross-language-check.mjs` establishes a real `RNS.Link` between this stack and a real Python `rns` process, then confirms `Link.sendResource()` transfers reassemble correctly in both directions — a real `RNS.Resource` receiving from this stack, and this stack receiving from a real `RNS.Resource` sender. Requires `pip install rns`:

```bash
PYLIBS=/path/to/site-packages npm run test:integration:resource
```

`test-integration/lxmf-propagation-cross-language-check.mjs` has this stack compute a real proof-of-work stamp and upload an LXMF message to a live `LXMF.LXMRouter` propagation node (the reference implementation, not this project's own `PropagationNode`), confirming the node accepts and stores it. Requires `pip install rns lxmf`:

```bash
PYLIBS=/path/to/site-packages npm run test:integration:lxmf-propagation
```

`test-integration/channel-cross-language-check.mjs` establishes a real `RNS.Link` between this stack and a real Python `rns` process, then confirms `Channel.send()` messages and `Buffer` streams reassemble correctly in both directions — a real `RNS.Channel`/`RNS.Buffer` receiving from this stack, and this stack receiving from real `RNS.Channel`/`RNS.Buffer`. Requires `pip install rns`:

```bash
PYLIBS=/path/to/site-packages npm run test:integration:channel
```

### Browser demo

`browser/index.html` shows your peer's 16-byte destination hash (RID), a copy button, and live mesh status: the number of open WebRTC links and the RIDs of peers you've received an announce from (click one to fill in the destination field). Enter a destination RID and a message and send; the message goes out as an LXMF-style message once you've received an announce from that peer's identity (your own identity is announced automatically every 10 seconds).

## Deploying the demo

`.github/workflows/deploy-pages.yml` builds `browser/` with Vite and publishes it to GitHub Pages on every push to `main` (or manually via "Run workflow"). It builds with `--base=/<repo-name>/` so asset paths resolve correctly under `https://<owner>.github.io/<repo>/`, and installs dependencies with `--ignore-scripts` since the Pages build only needs the browser bundle, not `node-datachannel`'s native binary.

One-time setup for a fork or new repo: in **Settings → Pages**, set **Source** to **GitHub Actions**. After that, pushes to `main` deploy automatically.

## Compliance

This project is a from-scratch reimplementation, checked against the real [`rns`](https://pypi.org/project/rns/) package (v1.3.7) rather than assumed compatible. It is **not fully compliant with Reticulum v1.0+ or with LXMF**, and still cannot join the official Reticulum/LXMF network — but part of the wire format now is verified, not just "protocol-compatible in spirit."

**Verified byte-for-byte against the reference implementation** (see `test/rns-compliance.test.js`, which encodes exact expected bytes captured from a real `rns` install for a fixed test identity):

- Identity hash (`SHA-256(public_key)[:16]`) and destination hash (`SHA-256(name_hash + identity_hash)[:16]`). An earlier version of this hashed the raw public key directly instead of the identity hash, producing destination hashes that were never compatible with real Reticulum — this is now fixed.
- Announces: field layout, signed data, and the Ed25519 signature itself all match byte-for-byte. Ed25519 signing is deterministic, so a matching signature over the same message is strong evidence the entire preceding computation is correct, not just superficially similar.
- Single-destination encryption (`RNS.Identity.encrypt`/`decrypt`): X25519 ECDH, HKDF (salt = identity hash), AES-256-CBC with PKCS7 padding, HMAC-SHA256 authentication, and the token layout (`ephemeral_pubkey + iv + ciphertext + hmac`) — including the fallback path used when no ratchet is available, where encryption goes directly to the destination's primary X25519 key.
- `Link`'s core handshake (`RNS.Link`): the LINKREQUEST packet (ephemeral X25519 + Ed25519 public keys plus 3-byte MTU/mode signalling), `link_id` derivation, the responder's PROOF packet (signed with the destination identity's real Ed25519 key, not an ephemeral one), the ECDH+HKDF handshake keyed by the link ID, and the Token-encrypted LRRTT/KEEPALIVE/LINKCLOSE/application-data packets that flow over an established link — all checked byte-for-byte, including the Ed25519 signature on the PROOF packet, against a full initiator/responder handshake captured from `rns`.
- `Link` Request/Response, small-payload form (`RNS.Link.request`/`handle_request`/`handle_response`): the `[timestamp, request_path_hash, data]` request envelope, the `[request_id, response_data]` response envelope, and that `request_id` (the packed REQUEST packet's own truncated hash) matches on both ends — all checked byte-for-byte, including decrypting real captured request/response ciphertext, against a captured exchange over a real link.
- `Transport`'s path request/response wire format (`RNS.Transport`): the well-known `rnstransport.path.request` control destination hash, the path request packet layout (destination hash + tag, or + a requesting transport instance ID), and a path-response announce's `context=PATH_RESPONSE` byte — all checked byte-for-byte. Hop-count-aware path discovery through an intermediate peer is verified functionally (not byte-exact, since it depends on which of several correct announces propagates first) with a 3-peer test topology.
- `node/tcp-gateway.js`'s HDLC framing matches `RNS.Interfaces.TCPInterface.HDLC` exactly, including escape-sequence handling.
- LXMF's core message envelope (`shared/rns/protocol.js`'s `lxmf_build`/`lxmf_parse`, OPPORTUNISTIC delivery method only): `destination_hash + source_hash + signature + msgpack([timestamp, title, content, fields])`, with the message hash/signature computed exactly as `LXMF.LXMessage.pack()` does — checked byte-for-byte against the real [`lxmf`](https://pypi.org/project/lxmf/) package (v1.0.1) for a fixed source/destination/timestamp (see `test/lxmf-compliance.test.js`), including the msgpack encoding itself (`shared/rns/msgpack.js` — a small spec-compliant encoder written specifically because `msgpackr`, used elsewhere in this codebase, optimizes whole-number floats and small maps into different bytes than LXMF's Python `umsgpack` produces, which would have silently broken the hash/signature match). Cross-language interop is verified directly, not just byte comparison: `test-integration/lxmf-cross-language-check.mjs` has a real Python `lxmf`/`rns` process and this JS stack exchange genuine signed LXMF messages over real TCP, in both directions, each side validating the other's Ed25519 signature.
- Packet-level delivery proofs, implicit form (`RNS.Packet.prove()`/`PacketReceipt.validate_proof()`): `protocol.build_packet_proof`/`validate_packet_proof` sign and verify the destination identity's Ed25519 signature over the original packet's full hash exactly as RNS does — checked byte-for-byte against a real captured packet, hash, and signature. `Destination.send(data, { requestProof: true })` returns a Promise that resolves once a matching proof is seen (or rejects on timeout), and a received `packet` event now carries a `.prove()` method for the receiving side to send one back — both opt-in, matching how real Reticulum leaves proving entirely up to the application.
- LXMF propagation-node stamps (`shared/rns/stamp.js`, matching `LXStamper`): the workblock derivation (repeated HKDF-SHA256 keyed by a message's transient_id) and the stamp validity check (leading zero bits of `full_hash(workblock+stamp)` against a target cost) are checked byte-for-byte against the real `lxmf` package — a stamp this project generates validates against real `LXStamper.stamp_valid()`, and vice versa. Peering-key stamps (used for node-to-node sync, which isn't implemented — see below) aren't included, and there's no parallel/multi-process search, so a given target cost takes considerably longer to satisfy here than in the reference implementation (which spreads the brute-force search across OS processes).

**Verified by live cross-language interop against a real Python process (not just byte comparison):**

- `Link.sendResource()` (`shared/rns/protocol.js`'s "RNS.Resource" section): a chunked-transfer implementation for payloads too large for a single packet, using RNS.Resource's exact wire primitives — the ADV/REQ/part/PROOF packet contexts and `ResourceAdvertisement`'s msgpack field layout (including 1-based segment numbering, and a part size matching `RNS.Link.MDU` exactly, both required for a real peer to agree on how many parts a transfer has), the same hashmap-based part-identification scheme (parts carry no explicit index; both sides identify one by hashing its content together with a shared random value), and the same completion-proof hash formula. The receiver requests parts in a **fixed-size window** rather than `RNS.Resource`'s adaptive one (which ramps up on a fast link) — but since a real sender doesn't care how a receiver paces its requests (it just resends whatever's asked for), this is enough for genuine two-way interop: `test-integration/resource-cross-language-check.mjs` has a real Python `RNS.Resource` correctly reassemble a transfer sent by this stack, and this stack correctly reassemble a transfer sent by real `RNS.Resource`, over a real `RNS.Link`. The one real gap is **compression**: real RNS bz2-compresses by default when it shrinks the payload, and this project doesn't implement decompression, so a real sender must be configured (or the data must not compress well, e.g. it's already encrypted/compressed/random) to avoid tripping this. Also bounded to a single segment (`RESOURCE_MAX_PARTS` parts of `RESOURCE_SDU` bytes each, currently ~55KB) — real RNS splits larger transfers across multiple advertised segments, which isn't implemented.
- LXMF propagation-node uploads (`shared/rns/propagation.js`'s `propagateLXMF()`): `test-integration/lxmf-propagation-cross-language-check.mjs` has this stack compute a real proof-of-work stamp at a live `LXMF.LXMRouter` propagation node's own required cost, upload a real LXMF message to it over a real `Link.sendResource()` transfer, and confirms the reference implementation accepts the stamp and stores the message under the transient_id this project computes independently. This is upload-only: **downloading**/syncing from a real propagation node isn't implemented, since a real node's `/get` handler identifies the requester via `RNS.Link.identify()` (proving your identity over an established link), a mechanism this project doesn't implement — this project's own `PropagationNode` (see below) instead has the requester embed a signature directly in the request payload, a different, JS-only mechanism.
- `Channel`/`Buffer` (`shared/rns/channel.js`, `shared/rns/buffer.js`): `Channel` is `RNS.Channel`'s reliable, sequenced message layer over a `Link` — the same 6-byte envelope header (`msgtype`/`sequence`/`length`), the same explicit per-packet delivery proof (an Ed25519 signature over the packet's own full hash, signed with the link's own signing key — distinct from `Resource`'s HMAC-style proof or the destination-level `identity.prove()` used for LXMF), and the same RTT-adaptive send window (starting at 2, growing/shrinking based on measured RTT and retry history, up to the same `WINDOW_MAX_FAST`/`_MEDIUM`/`_SLOW` tiers) — ported closely rather than simplified, since real peers' retry timing depends on it. `Buffer` is a raw byte-stream reader/writer built on top of `Channel`'s system-reserved `MSGTYPE` (`StreamDataMessage`'s stream-id/eof/compressed bit-packed header). `test-integration/channel-cross-language-check.mjs` has a real `RNS.Channel`/`RNS.Buffer` and this stack exchange both individual messages and multi-chunk streams in both directions over a real `Link`, each side correctly reassembling what the other sent. The one gap is the same as `Resource`'s: real RNS bz2-compresses a stream chunk when doing so shrinks it, and this project's `Buffer` writer never sets that flag nor decompresses one, so (as with `Resource`) a real sender's data needs to not compress well to interoperate. Deviates from the real API shape deliberately: no `MessageBase`-style registered message *classes* (real RNS only uses them as an ergonomic wrapper around a numeric `MSGTYPE`, the only part actually on the wire) and no `RawIOBase`/`BufferedReader`/`BufferedWriter` (an EventEmitter-based reader and a `write()`/`close()` writer instead).

**Verified functionally, but not byte-exact or fully spec-compliant:**

- `Link`'s operational lifecycle uses simple fixed intervals (15s establishment timeout, 30s keepalive) instead of `RNS.Link`'s RTT-adaptive keepalive/stale/timeout state machine (`KEEPALIVE_MIN`/`MAX` scaled by measured RTT, a separate STALE state before teardown, physical-layer stats). The wire format for each packet type is verified; the timing behavior around when they're sent is a simplification.
- `Transport`'s path discovery skips `RNS.Transport`'s interface-duty-cycle/roaming-mode rate limiting and retransmission grace periods (tuned for slow, shared-bandwidth radio links, e.g. LoRa — not relevant to a WebRTC mesh), and has no persistent "transport instance identity" concept, so outgoing path requests always use the simpler 2-field form (destination hash + tag, no transport ID).
- Multi-hop forwarding for single-destination DATA/PROOF packets (`Reticulum._forward`) is a simplified, single-destination-only analog of `RNS.Transport`'s hop-by-hop routing — verified functionally with a 3-peer A↔Relay↔B test where A sends an encrypted message that only reaches B via the relay, using `Interface.sendDataToPeer()` to target the specific next-hop neighbor from the path table (falling back to a broadcast for interfaces, like the TCP gateway's default, that don't otherwise distinguish neighbors).
- Multi-hop relaying of `Link` traffic (`Reticulum._forwardLinkRequest`/`_forwardLinkTraffic`): an intermediate peer that owns neither endpoint now forwards a LINKREQUEST toward the destination (using the same path-table next-hop lookup as single-destination forwarding), and remembers the link_id in a dedicated `linkTable` so the responder's PROOF and everything that flows over the link afterward — application data, Request/Response, KEEPALIVE, LINKCLOSE — gets routed back along the same path in either direction. A link_id isn't a real, announced destination, so it can't reuse the path table the way single-destination forwarding does. Verified functionally with a 3-peer A↔Relay↔B test: a real `Link` establishes, exchanges data both ways, round-trips a Request/Response, and tears down cleanly, entirely through a relay that never owns either endpoint's destination.
- LXMF propagation nodes, store-and-forward (`shared/rns/propagation.js`): a `PropagationNode` class accepts encrypted, addressed messages from a sender (uploaded over a `Link.sendResource()` transfer) it can't itself read, and serves them back to whoever proves ownership of the destination hash they're addressed to (an Ed25519 signature over the link ID, checked against an identity already known via announce) — the same core ideas as real LXMF's `LXMRouter`/`LXMPeer` (a dedicated `lxmf.propagation` destination, transient-id-keyed storage, a list-then-fetch `/get` sync protocol, proof-of-work admission stamps), verified functionally with a sender uploading a message for an offline recipient who later connects and syncs it down, and with a rejection test for a forged sync request. This whole subsystem — store, request/response, and identity proof — is this project's own design, not real LXMF's; it's real `RNS.Resource`-based uploads that interoperate with a real propagation node (see above), not this JS-only sync protocol as a whole. No node-to-node peer sync (`LXMPeer`'s "/offer" protocol and its own peering-key stamps), and no announce-encoded stamp-cost/capacity advertising (a sender must be told a node's required stamp cost out of band).

**Not yet implemented, and not compliant:**

- `RNS.Link.identify()`: proving your identity to the peer on the other end of an already-established link. Real LXMF propagation nodes require this for sync/download (see above); this project's Request/Response and propagation-node protocols instead have the caller embed whatever proof they need directly in the request payload.
- LXMF beyond OPPORTUNISTIC delivery and this project's own store-and-forward: no DIRECT (link-based) or real PROPAGATED delivery methods, no compression negotiation, and no `Resource`-based transfer for messages too large for a single packet. A message from this stack still can't reach an official LXMF client (Sideband, NomadNet) through a propagation node's normal use (that needs full node-to-node sync and a client able to download from the node, neither implemented), but two peers both running this codebase can already exchange messages directly, or store one on a JS `PropagationNode` for pickup later, and uploading to a *real* propagation node works too (see above).

In short: a peer running this codebase now produces and validates announces, single-destination encrypted packets (with opt-in delivery proofs), full `Link` handshakes/data exchange, small-payload Request/Response, path requests/responses, and single-packet LXMF messages that a real Reticulum/LXMF node would also consider valid, and the TCP gateway speaks real `TCPInterface` framing. Both single-destination messages and `Link`s (with everything that flows over one) can now be relayed multiple hops through an intermediate peer that owns neither endpoint. Payloads too large for a single packet can be sent as a `Resource`, or exchanged reliably via `Channel`/`Buffer`, with a real RNS peer able to actually receive (or send) either, and an LXMF message can be uploaded to a real LXMF propagation node for store-and-forward — confirmed against live reference-implementation processes, not just this project's own code talking to itself. What's still missing: `RNS.Link.identify()` (needed to download from a real propagation node), and real RNS's compression and (for `Resource`) multi-segment support. Note also that `Link`'s establishment doesn't currently drive the demo UI (`browser/main.js` messages over single-destination encryption directly) — it's available as a verified API, not yet wired into the chat demo.

## Known limitations

- Both single-destination messages and `Link`s (including everything sent over one, like Request/Response) can now be discovered and relayed across multiple hops through an intermediate peer that owns neither endpoint — see [Compliance](#compliance). A `Link` can now also send a payload too large for a single packet via `sendResource()`, or reliably exchange smaller messages/streams via `getChannel()`/`shared/rns/buffer.js`, and both genuinely interoperate with a real `RNS.Resource`/`RNS.Channel`/`RNS.Buffer` peer (confirmed live, in both directions) as long as the sender isn't compressing the data — Request/Response itself still has no `Resource` fallback for oversized payloads.
- An LXMF message can now be stored on a propagation node (`shared/rns/propagation.js`) for later pickup when the recipient isn't directly reachable, with a real proof-of-work admission stamp (`shared/rns/stamp.js`) that a live `LXMF.LXMRouter` accepts — uploading to a real propagation node works; downloading/syncing from one doesn't (needs `RNS.Link.identify()`, not implemented — see [Compliance](#compliance)).
- Identities, the announce/identity cache, links, and propagation node storage are in-memory only and are lost on restart.
- Signaling depends on public Nostr relays; relay operators can observe connection metadata (who is signaling whom, and when) even though offer/answer payloads are NIP-04 encrypted, and any of them may still rate-limit a busy key.
- `node-datachannel` (used for `RTCPeerConnection` in Node) ships prebuilt native binaries per platform; if none is available for your platform/Node version, `npm install` needs to build it from source.
- The browser UI in `browser/` is a minimal demo for exercising the stack, not a finished chat client.

## License

MIT — see [LICENSE](./LICENSE).
