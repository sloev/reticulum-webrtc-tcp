# reticulum-webrtc-tcp

A JavaScript reimplementation of a subset of the [Reticulum Network Stack](https://reticulum.network/) (RNS) wire protocol, using WebRTC data channels as the peer-to-peer transport and public [Nostr](https://nostr.com/) 
relays for connection signaling. Peers run in the browser or in Node.js and form a sparse mesh; a TCP gateway on the Node.js side bridges raw TCP connections into the mesh.

This is a from-scratch implementation, not a port of or a wrapper around the reference [`rns`](https://github.com/markqvist/Reticulum) Python implementation. Packet framing, identity/destination hashing, announces, single-destination encryption, the core `Link` handshake, path request/response discovery, small-payload `Link` Request/Response, and single-packet LXMF messages are now verified byte-for-byte against the real `rns`/`lxmf` packages. Single-destination messages can now be forwarded multiple hops through an intermediate peer; `Resource`/`Channel`, multi-hop `Link` relaying, and LXMF's propagation-node/stamp economy are not yet compliant. It still does not interoperate with the official Reticulum network, official LXMF clients (Sideband, NomadNet), or LXMF propagation nodes. See [Compliance](#compliance) and [Known limitations](#known-limitations) before relying on it for anything.

**Live demo:** https://sloev.github.io/reticulum-webrtc-tcp/ — the browser peer, built and deployed straight from `browser/` (see [Deploying the demo](#deploying-the-demo)). Open it in two tabs (or send someone the link) to form a mesh link over public Nostr relays and exchange messages.

## Architecture

```
shared/rns/                 Protocol implementation (transport-agnostic)
  crypto.js                   Ed25519 / X25519 / SHA-256 / HKDF / AES-CBC primitives (@noble/*)
  msgpack.js                    Spec-compliant MessagePack encoder/decoder (byte-exact with LXMF's Python umsgpack)
  protocol.js                  Packet framing, announces, Link, path requests, LXMF message envelopes
  index.js                     Reticulum router (path table), Identity, Destination, Link, Interface base class

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

- `Link`'s exact RTT-adaptive keepalive/stale/timeout state machine (this uses simple fixed intervals instead — see [Compliance](#compliance)), and packet-level delivery proofs (`RNS.Packet.prove()`/`link.validate()`).
- Requests/responses that don't fit in a single packet (no `Resource` fallback), and multi-hop relaying of an established `Link`'s traffic (only single-destination messages are forwarded — see [Compliance](#compliance)).
- A minimal LXMF-style message envelope (msgpack-encoded `[timestamp, title, content, fields]`, Ed25519-signed) — this mimics LXMF's basic header shape only; see [Compliance](#compliance).

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

**Verified functionally, but not byte-exact or fully spec-compliant:**

- `Link`'s operational lifecycle uses simple fixed intervals (15s establishment timeout, 30s keepalive) instead of `RNS.Link`'s RTT-adaptive keepalive/stale/timeout state machine (`KEEPALIVE_MIN`/`MAX` scaled by measured RTT, a separate STALE state before teardown, physical-layer stats). The wire format for each packet type is verified; the timing behavior around when they're sent is a simplification.
- `Transport`'s path discovery skips `RNS.Transport`'s interface-duty-cycle/roaming-mode rate limiting and retransmission grace periods (tuned for slow, shared-bandwidth radio links, e.g. LoRa — not relevant to a WebRTC mesh), and has no persistent "transport instance identity" concept, so outgoing path requests always use the simpler 2-field form (destination hash + tag, no transport ID).
- Multi-hop forwarding for single-destination DATA/PROOF packets (`Reticulum._forward`) is a simplified, single-destination-only analog of `RNS.Transport`'s hop-by-hop routing — verified functionally with a 3-peer A↔Relay↔B test where A sends an encrypted message that only reaches B via the relay, using `Interface.sendDataToPeer()` to target the specific next-hop neighbor from the path table (falling back to a broadcast for interfaces, like the TCP gateway's default, that don't otherwise distinguish neighbors).

**Not yet implemented, and not compliant:**

- Multi-hop relaying of `Link` traffic: LINKREQUEST packets and an established link's ongoing packets (DATA/LRRTT/KEEPALIVE/etc., and Request/Response) are not forwarded through an intermediate peer, only delivered when local. Doing so needs a separate "link table" — remembering, per link ID, which neighbor a relayed LINKREQUEST came from and went to, so the eventual PROOF and all subsequent traffic can be routed back along the same path — which is more machinery than the path-table-based forwarding used for single-destination messages.
- Requests/responses that don't fit in a single packet: real Reticulum falls back to a `Resource` transfer; there is no such fallback here.
- `Resource` / `Channel` / `Buffer`: not implemented (large-file transfer and buffered-channel protocols that build on top of `Link`). Packet-level delivery proofs (`RNS.Packet.prove()`/`link.validate()`) are also not implemented.
- LXMF beyond the OPPORTUNISTIC single-packet envelope: no propagation-node protocol or peer sync (`LXMRouter`/`LXMPeer`), no proof-of-work propagation stamps or tickets (`LXStamper`, required by real propagation nodes before they'll route a message), no DIRECT (link-based) or PROPAGATED delivery methods, no compression negotiation, and no `Resource`-based transfer for messages too large for a single packet — real LXMF falls back to a Reticulum `Link` + `Resource` for those, which isn't implemented here (see the `Resource`/`Channel` limitation above). A message from this stack still couldn't reach an official LXMF client (Sideband, NomadNet) through a propagation node, since that requires the stamp/ticket economy; direct peer-to-peer opportunistic delivery (the common case for two peers already in radio/link range of each other) is real and interoperable.

In short: a peer running this codebase now produces and validates announces, single-destination encrypted packets (now forwardable across multiple hops through an intermediate peer), full `Link` handshakes/data exchange, small-payload Request/Response, path requests/responses, and single-packet LXMF messages that a real Reticulum/LXMF node would also consider valid, and the TCP gateway speaks real `TCPInterface` framing. What's still missing: multi-hop relaying of `Link` traffic specifically, `Resource`/`Channel` transfers, and LXMF's propagation-node/stamp economy. Note also that `Link`'s establishment doesn't currently drive the demo UI (`browser/main.js` messages over single-destination encryption directly) — it's available as a verified API, not yet wired into the chat demo.

## Known limitations

- Single-destination messages can be discovered and forwarded across multiple hops now, but `Link`s cannot: an encrypted link (and anything sent over one, including Request/Response) still only works between two directly-connected peers, or bridged through the TCP gateway — see [Compliance](#compliance).
- Identities, the announce/identity cache, and links are in-memory only and are lost on restart.
- Signaling depends on public Nostr relays; relay operators can observe connection metadata (who is signaling whom, and when) even though offer/answer payloads are NIP-04 encrypted, and any of them may still rate-limit a busy key.
- `node-datachannel` (used for `RTCPeerConnection` in Node) ships prebuilt native binaries per platform; if none is available for your platform/Node version, `npm install` needs to build it from source.
- The browser UI in `browser/` is a minimal demo for exercising the stack, not a finished chat client.

## License

MIT — see [LICENSE](./LICENSE).
