# reticulum-webrtc-tcp

A JavaScript reimplementation of a subset of the [Reticulum Network Stack](https://reticulum.network/) (RNS) wire protocol, using WebRTC data channels as the peer-to-peer transport and public [Nostr](https://nostr.com/) 
relays for connection signaling. Peers run in the browser or in Node.js and form a sparse mesh; a TCP gateway on the Node.js side bridges raw TCP connections into the mesh.

This is a from-scratch implementation, not a port of or a wrapper around the reference [`rns`](https://github.com/markqvist/Reticulum) Python implementation. Packet framing, identity/destination hashing, announces, and single-destination encryption are now verified byte-for-byte against the real `rns` package; `Link`, `Transport` (path-finding/multi-hop routing), and LXMF are not yet compliant. It still does not interoperate with the official Reticulum network, official LXMF clients (Sideband, NomadNet), or LXMF propagation nodes. See [Compliance](#compliance) and [Known limitations](#known-limitations) before relying on it for anything.

**Live demo:** https://sloev.github.io/reticulum-webrtc-tcp/ — the browser peer, built and deployed straight from `browser/` (see [Deploying the demo](#deploying-the-demo)). Open it in two tabs (or send someone the link) to form a mesh link over public Nostr relays and exchange messages.

## Architecture

```
shared/rns/                 Protocol implementation (transport-agnostic)
  crypto.js                   Ed25519 / X25519 / SHA-256 / HKDF / AES-CBC primitives (@noble/*)
  protocol.js                  Packet framing, announces, destination hashing, LXMF-style messages
  index.js                     Reticulum router, Identity, Destination, Link, Interface base class

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
```

### Protocol layer (`shared/rns`)

Implements enough of Reticulum's wire format to interoperate between the peers in this repo. The pieces below are verified byte-for-byte against the real `rns` package (see [Compliance](#compliance)):

- Packet framing (flags byte, hop count, 16-byte destination hash, context byte, payload) matching Reticulum's on-wire layout.
- Destination hashing: `SHA-256(name_hash || identity_hash)`, where `identity_hash = SHA-256(identity_public_key)[:16]`, each truncated to 16 bytes.
- Announces: Ed25519-signed packets that broadcast an identity's public key and X25519 ratchet key; peers cache these to know who they can talk to.
- Single-destination data: X25519 ECDH with the announced ratchet key (or the destination's primary key, if no ratchet is known), HKDF-derived AES-256-CBC key with PKCS7 padding, and HMAC-SHA256 authentication.

Not yet verified or compliant:

- Links: an ephemeral X25519 handshake (link request/proof) followed by per-link AES-CBC + HMAC encrypted data packets — this is a rough approximation, not checked against `RNS.Link`.
- A minimal LXMF-style message envelope (msgpack-encoded `[timestamp, title, content, fields]`, Ed25519-signed) — this mimics LXMF's basic header shape only; see [Compliance](#compliance).

### Transport (WebRTC) and signaling (Nostr)

`shared/webrtc-rns-interface.js` defines an `Interface` whose `sendData` writes to every open `RTCDataChannel` and whose received bytes are handed back into the `Reticulum` router. `browser/webrtc-browser.js` and `node/webrtc-node.js` extend it with the connection setup logic:

- Peers discover each other by publishing a Nostr `kind 30000` parameterized-replaceable event tagged `reticulum-webrtc-mesh` every 60 seconds (`shared/nostr-signaling.js`), and connect to four public relays by default (`wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.nostr.band`, `wss://nostr.mom`).
- WebRTC offers and answers are exchanged as NIP-04 encrypted direct messages (`kind 4`) addressed by Nostr public key, with each side waiting (up to 3s) for local ICE candidate gathering before sending — one message per offer/answer instead of one per ICE candidate, since some public relays rate-limit high-frequency publishing from a single key.
- `RTCPeerConnection` is configured with a public STUN server (`stun:stun.l.google.com:19302`) so peers behind NAT can discover a reachable address for each other; there is no TURN server, so peers behind strict/symmetric NATs may still fail to connect directly.
- Offer collisions between two peers connecting simultaneously are resolved with the "polite/impolite" perfect-negotiation pattern, decided by comparing Nostr public keys.
- Each peer caps itself to `k = 4` simultaneous outgoing connections, so the mesh stays sparse rather than fully connected.

### Routing

`Reticulum.onPacketReceived` (`shared/rns/index.js`) parses the packet header on every interface. ANNOUNCE packets are validated and rebroadcast to the peer's other local interfaces so presence propagates through the mesh; DATA and PROOF packets addressed to a known destination or link are delivered locally. Any incoming byte stream whose first byte has its high bit (`0x80`) set is treated as opaque and relayed unparsed to the other local interfaces — this is how the TCP gateway bridges arbitrary traffic without needing it to be framed as an RNS packet.

There is no multi-hop path finding: forwarding only happens between the interfaces attached to a single local peer, not across the mesh.

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
- `node/tcp-gateway.js`'s HDLC framing matches `RNS.Interfaces.TCPInterface.HDLC` exactly, including escape-sequence handling.

**Not yet implemented, and not compliant:**

- `Link` (`shared/rns/index.js`): the link-request/proof handshake is a rough approximation, not checked against `RNS.Link` (keepalives, RTT tracking, MTU/resource-strategy negotiation, and more — 1,458 lines in the reference implementation). Treat links as unverified.
- `Transport`: no path-finding, transport tables, or multi-hop routing across independent Reticulum nodes (`RNS.Transport` is 3,613 lines implementing exactly this). Announce propagation here is still just "rebroadcast to this peer's other local interfaces" — see [Routing](#routing).
- `Resource` / `Channel` / `Buffer`: not implemented (large-file transfer, request/response, buffered-channel protocols).
- LXMF: the `lxmf_build`/`lxmf_parse` functions in `shared/rns/protocol.js` mimic LXMF's basic envelope shape (source hash, signature, msgpacked `[timestamp, title, content, fields]`) only — no propagation-node protocol, no proof-of-work propagation stamps (required by LXMF v0.9.x+ before propagation nodes will route a message), no compression/node-sync negotiation. A message from this stack sent to an official LXMF client (Sideband, NomadNet) or propagation node would still be rejected as malformed.

In short: a peer running this codebase now produces and validates announces and single-destination encrypted packets that a real Reticulum node would also consider valid, and the TCP gateway speaks real `TCPInterface` framing — but there's still no `Link`, `Transport`, `Resource`, or real LXMF compliance.

## Known limitations

- No multi-hop transport or path finding; reachability depends entirely on the local sparse-mesh topology (`k = 4`) actually connecting two peers, directly or via a bridging interface like the TCP gateway.
- Identities, the announce/identity cache, and links are in-memory only and are lost on restart.
- Signaling depends on public Nostr relays; relay operators can observe connection metadata (who is signaling whom, and when) even though offer/answer payloads are NIP-04 encrypted, and any of them may still rate-limit a busy key.
- `node-datachannel` (used for `RTCPeerConnection` in Node) ships prebuilt native binaries per platform; if none is available for your platform/Node version, `npm install` needs to build it from source.
- The browser UI in `browser/` is a minimal demo for exercising the stack, not a finished chat client.

## License

MIT — see [LICENSE](./LICENSE).
