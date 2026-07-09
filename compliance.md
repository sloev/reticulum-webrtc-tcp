# Compliance execution log

This is the historical execution log for the RNS/LXMF parity work on this project — the
phase-by-phase record of what was implemented, read, and verified, in the order it
happened. The current, canonical feature-parity table lives in
[README#compliance](./README.md#compliance); this file is not updated as that table
changes further. Read it for the reasoning behind a decision (why something was scoped
out, what a live check actually exercises, a bug found along the way) that the README's
table doesn't have room for.

## Ground rules

**Reference sources.** Everything is verified against the real packages, never from
memory:

```bash
pip install --target=/path/to/pylibs rns==1.3.7 lxmf==1.0.1
```

Read the Python source in `pylibs/RNS/` and `pylibs/LXMF/` (or unzip the wheels).
Every step below starts by reading the referenced Python code, porting constants and
algorithms exactly, and only then implementing.

**Verification ladder.** In order of preference, each feature gets:

1. **Byte-exact unit tests** (`test/rns-compliance.test.js`, `test/lxmf-compliance.test.js`)
   whenever a wire format is involved — ground-truth bytes captured from the real
   Python package with a fixed identity/timestamp.
2. **Live cross-language checks** (`test-integration/*-cross-language-check.mjs`) that
   spawn a real Python `rns`/`lxmf` process over real TCP:
   `PYLIBS=/path/to/pylibs npm run test:integration:<name>`. Re-run 2–3× — live checks
   involving proof-of-work or timing have real variance.
3. **Full regression** before every commit: `npm test`, `npx vite build`, and the
   existing integration checks touching the changed layer
   (`test:integration:resource`, `:channel`, `:lxmf`, `:lxmf-propagation`,
   `:lxmf-peer-sync`, `:path-request`, `:nomadnet`, `:sideband`, `:integration` for
   the sparse mesh).

**Process.** After each completed step: update the README Compliance table, commit with a
descriptive message, push. Never open a PR unless the user asks. Never claim a step done
without the verification it names.

**Sandbox notes.** Public Nostr relays are blocked by the environment's egress proxy —
browser-demo verification uses an in-page loopback `Interface` bridging two `Reticulum`
instances, driven by Playwright (`/opt/pw-browsers/chromium`,
`import ... from '/opt/node22/lib/node_modules/playwright/index.mjs'`). `pip` works
through the proxy.

## Execution phases

Executed strictly in order; each phase ended with the full regression suite green,
README's Compliance table updated, and a commit.

### Phase 0 — housekeeping — done

Commit the verified sessionStorage identity persistence (`browser/main.js`,
`browser/index.html`). Done: commit `b3f95fe`.

### Phase 1 — Link timing parity — done

Goal: replace the fixed 15 s establishment / 30 s keepalive timers with real RNS's
state machine. **Done.**

What was implemented, in `shared/rns/index.js`'s `Link`:

- Added `STALE = 3` (RNS values 0/1/2/4 already matched); ported constants
  `KEEPALIVE_MAX=360, KEEPALIVE_MIN=5, KEEPALIVE_MAX_RTT=1.75, STALE_FACTOR=2,
  STALE_GRACE=5, KEEPALIVE_TIMEOUT_FACTOR=4, DEFAULT_PER_HOP_TIMEOUT=6,
  ESTABLISHMENT_TIMEOUT_PER_HOP=6` (seconds, matching `RNS/Link.py:75–108`;
  converted to ms at point of use).
- Replaced `_startKeepalive`/`_armEstablishmentTimeout` (fixed `setInterval`/
  `setTimeout`) with a single rescheduling watchdog (`_watchdogTick`, chained
  `setTimeout`, since JS has no per-link thread to poll on a fixed cadence the way
  `__watchdog_job` does — the next check is instead recomputed and rescheduled
  whenever something that affects it changes): PENDING/HANDSHAKE → establishment
  timeout (initiator: `DEFAULT_PER_HOP_TIMEOUT + ESTABLISHMENT_TIMEOUT_PER_HOP ×
  max(1, hops)`, hops from the path table, matching `Link.py:283–284`; responder:
  `ESTABLISHMENT_TIMEOUT_PER_HOP × max(1, request.hops) + KEEPALIVE_MAX`, matching
  `Link.py:206`, which is deliberately generous since the responder must tolerate
  however long the initiator takes to receive the PROOF and reply). ACTIVE →
  initiator sends a keepalive when idle ≥ `keepalive`, transitions to STALE when
  idle ≥ `stale_time`, then tears down with reason `TIMEOUT` after `rtt ×
  KEEPALIVE_TIMEOUT_FACTOR + STALE_GRACE`; any inbound while STALE recovers to
  ACTIVE (`_noteInbound()`, called from `onPacket`/`onProof`).
- `_updateKeepalive()`: `keepalive = clamp(rtt × KEEPALIVE_MAX/KEEPALIVE_MAX_RTT,
  KEEPALIVE_MIN, KEEPALIVE_MAX)`, `stale_time = keepalive × STALE_FACTOR` — run once
  RTT is known on both sides (`_activateWatchdog()`, called from the initiator's
  PROOF handler and the responder's LRRTT handler).
- `_teardown()` now also rejects any pending `Link.request()` calls (a pre-existing
  gap — it only cleaned up outgoing resources before), so a torn-down link fails
  fast instead of hanging until a request's own timeout fires.
- **Real bug found and fixed along the way**: `stamp.generate_stamp()`
  (`shared/rns/stamp.js`) was a tight synchronous proof-of-work loop with no
  yielding. That was harmless under the old fixed-interval keepalive, but once
  Link's keepalive is *correctly* short for a fast connection (5–10s), a long
  synchronous stamp computation (this project's LXMF admission/peering-key stamps)
  starves the event loop long enough that a real peer's own — already-compliant,
  unmodified — stale/timeout logic can legitimately close the link out from under
  it. Real `LXStamper` doesn't have this problem because it searches in separate OS
  processes. Fixed by making `generate_stamp()`/`generate_peering_key()` `async`
  and yielding every ~15ms of wall time (`propagateLXMF()`/`syncToPeer()` in
  `propagation.js` updated to `await` them) — confirmed with a peer-sync run that
  took 24 s to compute a peering key and still completed successfully.

Tests: unit (`test/rns-compliance.test.js`) — keepalive-formula vectors at the
MIN/MAX/interpolated RTT points; STALE transition, STALE→ACTIVE recovery on
inbound, and teardown-with-reason-TIMEOUT, all driven directly via `_watchdogTick()`/
`_noteInbound()` with back-dated timestamps rather than real waiting (keeps the
tests fast — real keepalive/stale timing has a 15s floor). Live — `test:integration:
resource`, `:channel`, `:lxmf-propagation`, and `:lxmf-peer-sync` all re-verified
against real `rns`/`lxmf` (the peer-sync check in particular now reliably survives
a multi-second synchronous PoW computation without the real node closing the link).

Done when: fixed-interval constants are gone, all tests green, checklist + README rows
updated.

### Phase 2 — Resource parity

**2.1 Rate-adaptive window — done at the time (growth half only; retry-shrink added later, see below).**
Implemented in `shared/rns/index.js`'s `Link._growResourceWindow()`/
`_requestNextResourceParts()`/`_onResourcePart()`: each incoming Resource tracks its own
`window` (starts at `RESOURCE_WINDOW=4`), `windowMax` (starts at
`RESOURCE_WINDOW_MAX_SLOW=10`), `windowMin` (`RESOURCE_WINDOW_MIN=2`), and per-round byte/
time counters. On each fully-satisfied request round: `window` grows by 1 while `window <
windowMax` (with `windowMin` creeping up once the gap exceeds `RESOURCE_WINDOW_FLEXIBILITY`,
matching `Resource.py:900-903`); the round's throughput (`bytes received this round / round
duration`) is compared against `RESOURCE_RATE_FAST`/`RESOURCE_RATE_VERY_SLOW` to promote
`windowMax` to `RESOURCE_WINDOW_MAX_FAST=75` after `RESOURCE_FAST_RATE_THRESHOLD` consecutive
fast rounds, or demote it to `RESOURCE_WINDOW_MAX_VERY_SLOW=4` after
`RESOURCE_VERY_SLOW_RATE_THRESHOLD` consecutive very-slow ones (`Resource.py:914-924`).
Constants live in `shared/rns/protocol.js`.

**Not implemented, and intentionally out of scope for this step**: retry-driven window
*shrinking* (`Resource.py:612-621`) and the part-timeout/retry mechanism it depends on
(`PART_TIMEOUT_FACTOR=4`, `_AFTER_RTT=2`, `MAX_RETRIES=16`, `MAX_ADV_RETRIES=4`) — this
project's Resource receiver has no per-part timeout/retry at all yet (it relies on the
outer `sendResource()`-level timeout only), so there's nothing for a shrink to attach to.
Adding that is a distinct, separable piece of work from window growth; revisit as its own
step if real-world packet loss on WebRTC/TCP ever makes it worth doing (it doesn't affect
interop — a real peer doesn't care how the receiver paces its own requests).

Verified: unit test (`test/rns-compliance.test.js`) sends a 30-part payload and asserts the
observed window sequence is monotonically non-decreasing and exceeds the initial window of
4. Live: `test:integration:resource` re-verified in both directions, including a real
`RNS.Resource` sender's ~180KB multi-segment transfer to our (window-adaptive) receiver.

**2.2 Outgoing bz2 compression — done.**

`compressjs` (the obvious pure-JS bzip2 encoder, same author as `seek-bzip`) turned out to
be GPL-licensed — bundling it would attach copyleft obligations to this project's
MIT-licensed browser bundle, so it was rejected on licensing grounds rather than technical
ones. Used `bzip2-wasm` instead: a WebAssembly build of the actual reference `libbzip2` C
library (the same one Python's `bz2` module wraps), under `libbzip2`'s own permissive
BSD-style license. Being the real reference implementation rather than an independent
reimplementation, its output isn't just *a* valid bz2 stream — it's byte-identical to what
`bz2.compress()` itself produces for the same input (verified directly).

Implemented in `shared/rns/compression.js`: `bz2_compress()` (sizes the output buffer to
libbzip2's own documented worst-case bound — its own default guess of `input.length` isn't
big enough for incompressible data and throws `BZ_OUTBUFF_FULL`, which is what actually
happened first) and `bz2_compress_if_beneficial()`, matching `RNS.Resource`'s exact policy
(`Resource.py:384-421`): always attempt compression up to `AUTO_COMPRESS_MAX_SIZE` (64MiB),
use the compressed bytes only if they're smaller. Wired into `Link._sendResourceSegment()`
(Resource — the resource's hash/proof/`dataSize` are always computed over the *original*
uncompressed plaintext, matching real RNS, since compression is transparent to the
resource's own identity) and `buffer.js`'s `RawChannelWriter.write()` (Buffer, per chunk —
this made `write()` async, so its two callers now `await` it; its return value is still the
count of *uncompressed* input bytes consumed, matching real RNS's contract for offset
tracking). The advertisement/`StreamDataMessage` compressed bit (already parsed on receive)
is now also set on send.

**Known caveat, environment-specific, not a compliance gap**: `bzip2-wasm`'s Emscripten
glue resolves its `.wasm` file relative to its own script location, which doesn't survive
Vite's dev-server dependency pre-bundling cleanly in every case (`optimizeDeps.exclude:
['bzip2-wasm']` in `vite.config.js` was added to help). This doesn't affect the deployed
demo — the demo's chat UI never calls `sendResource()`/`Buffer` at all, and the actual
*production* build (`vite build`, what's deployed to GitHub Pages) was verified working
end-to-end in real headless Chromium (compress, decompress, and the incompressible-data
fallback all correct). It would only matter for a consumer directly exercising
Resource/Buffer from browser code under `vite dev`-style tooling.

Verified: byte-exact unit test (`bz2_compress()` output matches real `bz2.compress(data,
9)` for a fixed input) and a compressible-vs-incompressible decision test
(`test/compression.test.js`); live — `test:integration:resource` (real `RNS.Resource`
explicitly reports `compressed=True` for a compressible JS-sent transfer and `False` for a
high-entropy one) and `test:integration:channel` (real `RNS.Buffer` correctly reassembles a
compressed JS-sent stream); a real headless-Chromium session running the actual
`vite build` production bundle.

**2.3 HMU receive path — done at the time (receive side only; send side added later, see below).**

Implemented in `shared/rns/protocol.js` (`CONTEXT_RESOURCE_HMU=0x04`, `RESOURCE_HASHMAP_MAX_LEN
= floor((LINK_MDU-134)/RESOURCE_MAPHASH_LEN)` = 74 at the default MTU, matching
`ResourceAdvertisement.HASHMAP_MAX_LEN` exactly; `build/parse_resource_request` extended for
the exhausted-flag-plus-last-map-hash form; `build/parse_resource_hmu` for the HMU packet
itself) and `shared/rns/index.js` (`Link._onResourceAdvertisement` now only fills in as many
`hashmapEntries` as the advertisement actually included, rather than assuming it always covers
every part; `_requestNextResourceParts` detects running out of known entries mid-window and
sends an exhausted-flagged request instead of just stopping; `_onHashmapUpdate` appends the
next chunk and resumes; `_onResourcePart`'s completion check now compares against the true
`parts.length` rather than the possibly-still-partial `hashmapEntries.length`).

**Send side intentionally not implemented**: this project's own sender still always includes
the whole hashmap in one advertisement regardless of size (see 2.1's `RESOURCE_SEGMENT_MAX_SIZE`
note) — both a real RNS receiver and this project's own receiver already tolerate that (the
`HASHMAP_MAX_LEN` limit is a real-RNS *sender's* own packet-fitting choice, not a receiver-side
rule), so there was nothing broken to fix, and truncating our sender's own advertisements would
mean also implementing genuine send-side HMU-response generation — a distinct, separable
addition with no interop benefit today, left for later. Raising send-side segmentation toward
`MAX_EFFICIENT_SIZE` (1 MiB−1) is bundled with that same later step, for the same reason.

Verified: unit tests (`test/rns-compliance.test.js`) — wire-format round-trip for both new
message shapes, and a full transfer built by hand with an advertisement hashmap deliberately
truncated to 3 of 7 entries, confirming the request-exhausted → HMU → resume flow completes
correctly end to end. Live: `test:integration:resource` — a real `RNS.Resource` sender given a
40000-byte (~87-part, safely over the 74-entry threshold) payload correctly truncates its own
advertisement and this project's receiver correctly requests, receives, and applies the HMU
packet to reassemble it (re-run twice for stability).

### Phase 3 — Request/Response Resource fallback — done

Read `RNS/Link.py:473–508` (request path) and `:842–850` (response path). A packed
request or response that exceeds `LINK_MDU` is sent as a Resource instead of a single
packet, tagged with a `request_id`: for a request this is `Identity.truncated_hash`
of the packed `[timestamp, path_hash, data]` payload (`resource_request_id()` in
`shared/rns/protocol.js` — a plain hash of the payload itself, distinct from the
single-packet path's `packet_truncated_hash()` of the outer packet, since a Resource
has no single "packet" to hash); for a response it's the same `request_id` the
request carried. `build_resource_advertisement()`/`parse_resource_advertisement()`
(`shared/rns/protocol.js`) now carry `q` (`request_id`) and the `is_request`/
`is_response` flag bits, matching `ResourceAdvertisement`'s flags byte layout exactly.

`Link.request()` (`shared/rns/index.js`) now checks payload size before choosing a
single packet vs. `sendResource(payload, { requestId, isRequest: true })`; `_handleRequest()`
does the same for the response. On the receive side, `_assembleResource()` checks the
completed incoming Resource's `isRequest`/`isResponse` flags and routes it to
`_handleRequest()`/`_handleResponse()` instead of emitting a generic `'resource'` event —
matching how real RNS keeps these internal rather than exposing them to the application.

Verified: unit tests (`test/rns-compliance.test.js`) — advertisement round-trip of the
new flags/`request_id` field, and a full JS-to-JS request/response exchange forced
through the Resource path in both directions (`'x'.repeat(LINK_MDU * 2)` used for both
the request name and the handler's reply). Live: `test:integration:lxmf-propagation`
extended to upload 4 LXMF messages (1 original + 3 padded "bulk" messages) to a real,
unmodified `LXMF.LXMRouter` propagation node, then call `syncFromRealPropagationNode()`
— its `/get` response now exceeds `LINK_MDU`, exercising the real reference
implementation's own oversized-response-as-Resource path (not a synthetic one); all 4
messages downloaded and verified byte-for-byte (re-run 3× for stability). Full
regression also re-run clean: 59/59 unit tests, `vite build`, and the resource/channel
live checks.

### Phase 4 — Transport parity — done

Read `RNS/Transport.py`'s `request_path()`/`path_request_handler()` (:2799–2939) and
the announce rate table (:1890–1911). Implemented in `shared/rns/index.js`'s
`Reticulum`:

1. **Path-request throttling.** `requestPath()` now records the last request time per
   destination (`pathRequestTimestamps`, matching `Transport.path_requests`) and
   suppresses a repeat call for the same destination within `PATH_REQUEST_MI_MS`
   (20s, `Transport.py:83`). Real RNS only applies this constant to its own
   *automatic* retry logic (failed-link rediscovery); this project has no such
   background retry system, so the throttle is applied directly at the public
   `requestPath()` call site instead — a more general application of the same
   constant, and the more useful place for it in a project without RNS's internal
   job loop.
2. **Transport instance identity + 3-field path requests.** Every `Reticulum`
   instance now creates a persistent `transportIdentity` (`Identity.create()`,
   in-memory only — see Phase 7) whose hash is sent in every outgoing path request,
   matching the 3-field form (`dest + transport_id + tag`) real RNS only sends when
   `transport_enabled()` (`Transport.py:2811`). This project's mesh nodes always
   forward packets for destinations they don't own (see `_forward`/
   `_forwardLinkRequest`) — i.e. they're always acting as a transport node — so the
   3-field form is used unconditionally rather than gated behind an explicit
   transport-enabled toggle real RNS has and this project doesn't model.
   `build_path_request()`/`parse_path_request()` already round-tripped both forms
   (the 2-field form is now the explicit non-transport case, still used when no
   transport identity is passed).
3. **Path table expiry.** A periodic job (`_cleanupPathTable()`, hourly) drops path
   table entries untouched for longer than `DESTINATION_TIMEOUT_MS` (7 days,
   `Transport.py:91`), so a long-running peer's path table doesn't grow unbounded
   with stale routes — real RNS's own destination-timeout mechanism, minus its
   `held_announces`/announce-table retry bookkeeping (see below).
4. **Announce rate table.** Each announce now records a timestamp in
   `announceRateTable`, capped at `MAX_RATE_TIMESTAMPS` (16, `Transport.py:96`) per
   destination — the mechanism real RNS uses to *count* announce rate. Left
   unenforced, matching real RNS's own default: an interface's
   `announce_rate_target` is `None` unless explicitly configured, so out of the box
   a real RNS node doesn't reject fast announces either. Porting the mechanism
   without inventing a default this project has no basis for keeps parity with
   RNS's actual out-of-box behavior rather than adding a restriction real RNS
   itself doesn't apply by default.

**Scoped out:** `PATH_REQUEST_GRACE`/`PATH_REQUEST_RG` (a short delay before
rebroadcasting a *cached* path-request answer, to let a more directly-reachable peer
answer first) and `LOCAL_REBROADCASTS_MAX` (capping how many times a non-owned
announce is locally rebroadcast) are both LAN-collision-avoidance optimizations tied
to `RNS.Transport`'s `announce_table`/retry/dedup state machine and roaming-mode
interface concept — neither of which this project's simpler flood-based mesh
architecture has a natural home for, and neither affects correctness or genuine
interop: a real peer's path request is answered correctly whether we take 0ms or
400ms to do it. Same category of gap as Phase 2's resource-shrink scoping — a real
mechanism intentionally not ported because nothing here depends on it.

Verified: unit tests (`test/rns-compliance.test.js`) — `requestPath()`'s 3-field form
and throttling (including a different destination's timer being unaffected),
`_cleanupPathTable()` dropping only stale entries, and the announce rate table's
16-entry cap. Live: new `test:integration:path-request` — a real, unmodified `rns`
process's own `path_request_handler()` correctly parses this stack's 3-field path
request (not the previous 2-field-only form) and answers with a valid announce for
a destination it owns, and a repeat `requestPath()` call is confirmed suppressed
rather than resent (re-run 3× for stability). Full regression re-run clean: 62/62
unit tests, `vite build`, and the sparse-mesh live check (unaffected by these
changes, still passing).

### Phase 5 — LXMF outbound parity

**5.1 DIRECT delivery — done.** Read `LXMF/LXMessage.py:355–460` (`pack()`) and
`:626–654` (`__as_packet`/`__as_resource`). Correction to the plan as originally
written: reading the actual source shows the destination-hash prefix is the other
way around from what's stated above — **OPPORTUNISTIC** is the one that omits it
(implied by the packet's own destination), while **DIRECT** keeps the full
`destination_hash + source_hash + signature + msgpack_payload` layout (`self.packed`,
unsliced) as-is over the Link, since the Link's own outer packet is addressed to the
link_id, not the LXMF destination — confirmed both by reading `__as_packet()`
(`RNS.Packet(self.__delivery_destination, self.packed)`, no slice, vs. OPPORTUNISTIC's
`self.packed[DESTINATION_LENGTH:]`) and by capturing a real `LXMessage(desired_method=
DIRECT).pack()` byte vector for the project's fixed test identities.

Implemented: `protocol.js`'s `lxmf_build_direct()`/`lxmf_parse_direct()` (the full
4-field wire form) alongside the existing OPPORTUNISTIC `lxmf_build()`/`lxmf_parse()`
(refactored to share the common sign/hash logic via a private `lxmf_sign()` helper).
`Link.sendLXMF(source, title, content, fields)` (`shared/rns/index.js`) picks
representation exactly like `LXMessage.pack()` does: a plain link packet if the built
payload fits within `LINK_MDU`, otherwise a Resource (already auto-compressed, same as
any other Resource here — real compression *negotiation* via a peer's announced
`SF_COMPRESSION` is Phase 5.2). Receive side: `Link.onPacket()`'s `CONTEXT_NONE`
branch and `_assembleResource()`'s completed-Resource branch both now try
`tryParseLxmfDirect()` first (mirroring how `Destination.onData()` already tries
OPPORTUNISTIC `tryParseLxmf()` before falling back to a plain `'packet'` event) and
emit an `'lxmf'` event instead of `'packet'`/`'resource'` on a match — no destination
prepending needed, since DIRECT's wire form already carries its own.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the DIRECT wire form's
byte-exact match against a real `LXMessage.pack()` capture (including the
destination-hash-included layout), signature rejection, and two full JS-to-JS Link
tests (packet-sized and `LINK_MDU`-exceeding Resource-sized, confirming the `'lxmf'`
event fires instead of `'packet'`/`'resource'`). Live: `test-integration/rns_node.py`
extended with a Link-scoped LXMF packet/resource callback on its `lxmf.delivery`
destination and a `send_lxmf_direct` command (using `LXMessage.pack()` +
`RNS.Packet`/`RNS.Resource` directly against an established Link, the same primitives
`LXMessage.send()` uses internally, without needing a full `LXMRouter` for this
wire-format-focused check); `lxmf-cross-language-check.mjs` extended to exchange
DIRECT messages in both directions, both packet-sized and Resource-sized (re-run 3×
for stability). Full regression re-run clean: 66/66 unit tests, `vite build`, and the
`resource`/`lxmf-propagation`/`lxmf-peer-sync` live checks (unaffected, still passing).

**5.2 Delivery announce app_data + compression negotiation — done.** Read
`LXMRouter.get_announce_app_data()` (LXMRouter.py:985–1000), `LXMF.stamp_cost_from_
app_data()`/`compression_support_from_app_data()` (LXMF.py:174–200), and
`LXMessage.determine_compression_support()` (LXMessage.py:510–517).

Implemented in `shared/rns/protocol.js`: `lxmf_build_announce_app_data(display_name,
stamp_cost)` builds the `[display_name|null, stamp_cost|null, [SF_COMPRESSION]]`
msgpack structure (byte-exact against a real `get_announce_app_data()`-equivalent
capture, both empty and populated); `lxmf_stamp_cost_from_app_data()` and
`lxmf_compression_supported()` parse it back out, matching the real functions'
exact semantics — including the non-obvious case where an app_data *is* present but
its functionality list doesn't include `SF_COMPRESSION` (returns `false`, not a
permissive default; only *no app_data at all* defaults to `true`, folding in
`determine_compression_support()`'s own no-app_data fallback). `Destination.announce()`
gained an `appData` option (previously always empty) so a caller can attach this.
`Link.sendLXMF()` now looks up the recipient's most recently cached announce
app_data (already stored per-destination on every announce) and passes
`autoCompress` through to `sendResource()`/`_sendResourceSegment()` (both gained the
same option, default `true`) — skipping the compression attempt entirely rather than
compressing and discarding the result, when the recipient has explicitly signaled no
support.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the app_data byte-exact
round-trip, the "present but no SF_COMPRESSION" parsing case, and a full JS-to-JS
Link test confirming the *sent advertisement's own compressed flag* is `false` (not
just that decompression still works either way) when the recipient announced no
support. Live: `lxmf-cross-language-check.mjs` extended so a real, unmodified `rns`/
`lxmf` process re-announces its `lxmf.delivery` destination with a real
`get_announce_app_data()`-shaped app_data declaring no compression support, and
confirms — from the real `RNS.Resource`'s own `compressed` attribute on the
Python side — that JS's next oversized DIRECT send skipped compression in
response to that real announce (re-run 3× for stability). Full regression re-run
clean: 69/69 unit tests, `vite build`.

**5.3 Propagation-node announce app_data — done.** Read `LXMRouter.
get_propagation_node_app_data()` (LXMRouter.py:300–318) and `LXMF.pn_announce_data_
is_valid()`/`pn_stamp_cost_from_app_data()` (LXMF.py:174–246).

Implemented in `shared/rns/protocol.js`: `lxmf_build_propagation_announce_app_data()`
builds the 7-element `[false, timebase, node_state, per_transfer_limit_kb,
per_sync_limit, [stamp_cost, stamp_cost_flexibility, peering_cost], metadata]` list
— byte-exact against a real `get_propagation_node_app_data()`-equivalent capture,
including the metadata dict's integer-keyed `PN_META_NAME` entry (needed a `Map`
rather than a plain JS object, since a plain object's keys are always coerced to
strings — `Object.entries({1: x})` would have msgpacked the key `1` as the *string*
`"1"`, not the integer real LXMF expects, a mismatch that would have silently broken
interop). `lxmf_parse_propagation_announce_app_data()` validates and parses it back,
matching `pn_announce_data_is_valid()`'s exact rules (7 elements, decodable
timebase, strictly-boolean node_state, integer transfer/sync limits, a 3-element
integer stamp-cost list, dict-typed metadata) — returning `null` for anything that
fails, mirroring `pn_stamp_cost_from_app_data()`'s own `None` fallback rather than
throwing.

`PropagationNode.announce()` now embeds this using the node's own configured
`stampCost`/`peeringCost` (previously always empty). `propagateLXMF()`/`syncToPeer()`
both changed their `stampCost`/`peeringCost` parameter default from a fixed number to
`null`, meaning "read it from the destination's most recently cached announce
app_data" (already stored per-destination on every announce, same cache Phase 5.2
reads for compression support) — computing `stamp_cost - stamp_cost_flexibility` as
the safe target, same as a real LXMF client would; an explicit number still works as
an override for cases where the announce isn't available yet, or (as in the peer-sync
live test below) where the relevant announce belongs to a different destination than
the one being called through.

Verified: unit tests (`test/lxmf-compliance.test.js`) — the app_data byte-exact
match (cross-checked against a real fixed-timebase capture) and validation-rejection
rules, plus two full JS-to-JS tests confirming `propagateLXMF()`/`syncToPeer()`
read the cost from a `PropagationNode.announce()` rather than needing it
passed. Live: both `lxmf-propagation-cross-language-check.mjs` and
`lxmf-propagation-peer-sync-cross-language-check.mjs` extended to make
`lxmf_propagation_node.py` call the real `LXMRouter.announce_propagation_node()`
(firing ~20s later, `NODE_ANNOUNCE_DELAY`) and have JS wait for and parse that real
announce, cross-checking every field against the test harness's own out-of-band
values before using *only* the parsed announce to drive `propagateLXMF()`/
`syncToPeer()`'s cost (re-run twice each for stability, given the added real-world
timing dependency). Full regression re-run clean: 73/73 unit tests, `vite build`,
and the `lxmf`/`resource`/`channel` live checks.

### Phase 6 — end-user client interop — done

**NomadNet.** `pip install --target=$PYLIBS nomadnet`. Its real `-d`/`--daemon` mode
runs headless (a `NomadNetworkApp` with `daemon=True` never touches its
TUI) — no TUI automation needed at all for the receiving direction, and for sending,
`nomadnet.Conversation`'s own code calls exactly `app.message_router.
handle_outbound(lxm)` (confirmed by reading `Conversation.py:320,394`), so this
project's `test-integration/nomadnet_driver.py` drives NomadNet's own real
`NomadNetworkApp` instance (built the same way `nomadnet -d` itself does — same
identity file, same `LXMRouter`, same start-of-day announce after
`NomadNetworkApp.START_ANNOUNCE_DELAY=3s`) and calls that exact same router method
directly, rather than reimplementing or synthesizing a message. `test-integration/
lxmf-cross-language-check.mjs`'s pattern extends cleanly here too. Confirmed both
directions: JS's OPPORTUNISTIC send is received and written to NomadNet's own
`storage/conversations/<hash>/` on disk; NomadNet's own outbound call is received and
validated by this stack. Also confirmed NomadNet's real announce app_data
(`[display_name, stamp_cost, [SF_COMPRESSION]]`) is parsed correctly by
this project's Phase 5.2 functions, cross-checked against NomadNet's own configured
display name — not just against a synthetic byte vector.

**Sideband.** `pip install --target=$PYLIBS sbapp`. **Correction to this plan's own
original assumption**: Sideband was expected to be infeasible headless (it's a
Kivy/KivyMD GUI app) — it isn't. Reading `sbapp/main.py` shows its entire
Kivy/KivyMD/LXST(audio) import block is gated behind `if not args.daemon:`, so real
`-d`/`--daemon` mode never imports Kivy's graphics stack at all — confirmed by
actually running it with no virtual display and observing a clean daemon startup
with no GL/display errors. `SidebandCore(...).start()` (the same two calls
`sbapp.main.run()` makes for `-d` mode) returns normally rather than blocking
forever, so `test-integration/sideband_driver.py` calls them directly and layers a
thin delivery-callback wrapper (`LXMRouter.register_delivery_callback()` only ever
keeps one callback, so re-registering one that emits a JSON event then forwards to
Sideband's own real `lxmf_delivery` was the cleanest hook) to observe receipt without
touching Sideband's own logic. Sending uses Sideband's own public `send_message()` —
the same method its UI's send button calls — which itself defaults to LXMF's DIRECT
method (opening a real `Link`) rather than OPPORTUNISTIC when no ratchet is yet known
for the recipient, so this also exercises this project's DIRECT delivery
(Phase 5.1) against a real end-user client, not just bare `lxmf`. Confirmed both
directions, live, against the real unmodified client (re-run 3× each for stability).

Both `test-integration/nomadnet-interop-check.mjs` and `test-integration/sideband-
interop-check.mjs` require their respective package installed into `$PYLIBS` in
addition to `rns`/`lxmf` (`pip install --target=$PYLIBS nomadnet` / `sbapp`) — not
part of this project's own `package.json`, since they're reference clients for this
one-off interop verification, not a runtime dependency.

**Not attempted**: propagation-node interop with either client (only direct
delivery, both methods, both directions) — the existing `LXMRouter`-based
propagation checks (Phase 5.3) already cover the propagation-node wire format
against the reference implementation; a client-specific propagation test would
mostly re-exercise the same code path through a heavier dependency, for limited
additional confidence.

### Phase 7 — persistence parity — done (adaptation scope)

Implemented `shared/rns/storage.js`'s `NodeFileStorage` — a Node-only, one-file-
per-key filesystem adapter (`save`/`load`/`listKeys`/`delete`, msgpack-encoded) —
plus explicit `async saveState(storage)`/`async loadState(storage)` methods on
`Reticulum` (identity cache + path table) and `PropagationNode` (message store,
one file per transient_id in spirit, matching `LXMRouter`'s storagepath layout —
not its exact on-disk byte format, since nothing else ever reads this off disk).
Wired as opt-in in `node/index.js` via `RNS_STORAGE_DIR`: loads on startup, saves
every 5 minutes and on `SIGINT`/`SIGTERM`; unset, behavior is unchanged
(in-memory only, as before). No browser adapter — the browser demo's existing
sessionStorage-based identity caching already covers the one thing worth
persisting in a page that's otherwise fully reset on close; a longer-lived
browser peer wanting the same persistence would implement an IndexedDB adapter
against the same `save`/`load`/`listKeys` interface.

A reloaded path table entry can still answer a path request from its cached
announce packet, but not serve as a `_forward()` next-hop (the interface/peer
object references it was learned from aren't serializable, and are dropped on
reload) until a live announce refreshes it — a real, documented limitation of
treating this as a plain adaptation rather than reimplementing RNS's full
per-interface reconnection model.

**Scoped out: ratchet rotation** (`RNS.Destination.rotate_ratchets`, `Destination.
py:210–243`). This project's `Identity` currently generates one static ratchet at
creation and never rotates it — a real, separate gap from persistence itself (it
exists with or without a storage layer), and a large enough behavioral change
(retained-ratchet history, a rotation interval, decrypt-fallback trying each
retained ratchet within its grace period) that folding it into this phase would
mean either a shallow implementation or expanding this phase well past what
"persistence adaptation" scoped for. Left as a genuine, separable follow-up
rather than force-fit here.

Verified: unit tests (`test/storage.test.js`) — `NodeFileStorage` round-tripping
arbitrary values (including `Uint8Array` fields) and managing a one-file-per-key
directory, `Reticulum.saveState()`/`loadState()` surviving a simulated restart
(a fresh `Reticulum` instance reloading a previous one's saved identities/path
table), and `PropagationNode.saveState()`/`loadState()` round-tripping the
message store and cleaning up on-disk files for since-purged messages. A manual
smoke test confirmed `node/index.js`'s wiring loads/saves correctly end to end
(the gateway itself couldn't be run as a full process in this sandbox — see
README's Known limitations re: `node-datachannel`'s native build — but the
storage code path itself, unrelated to WebRTC, was verified directly). 77/77
unit tests pass; `vite build` confirms `storage.js` (Node-only, uses `node:fs/
promises`) isn't pulled into the browser bundle (module count unchanged at 78).

### Phase 8 — docs finalization — done

Swept every checklist row above: none left `MISSING`/`UNTESTED`; the few `PARTIAL`
rows (Resource window's retry-shrink, single-destination-only multi-hop forwarding,
announce rate table enforcement) each carry an honest reason in their own phase
writeup, not just an unexplained gap. README's intro paragraph, "In short" summary,
and "Known limitations"/"Not yet implemented" sections rewritten to match — the
latter renamed to "Remaining gaps" since almost everything it used to list is now
done; DIRECT delivery, Transport parity, and RTT-adaptive Link timing folded into
the top summary's byte-exact list. Found and fixed several stale code comments left
over from before Phases 1–5 landed (`shared/rns/index.js`/`protocol.js`/
`propagation.js`): a "fixed-size window" comment on the now-rate-adaptive Resource
receiver, a "no outgoing compression" note on the now-bidirectionally-compressing
Resource/LXMF paths, an "isn't implemented here, so a sender must be told out of
band" note on propagation stamp costs that Phase 5.3 made announce-derived, a
"that fallback is not implemented here" note on the Request/Response Resource
fallback Phase 3 added, and a stale "LINKREQUEST packets... aren't forwarded" README
paragraph that predated `_forwardLinkRequest`/`_forwardLinkTraffic`. Demo page
copy (`browser/index.html`) was already kept accurate incrementally each phase
(no LXMF-scope claims changed enough to need a demo-copy update this pass).

Full regression re-run clean one final time: 77/77 unit tests, `vite build`, and a
spot check of the live integration suite (`path-request`, `lxmf`, `resource`) —
see the status log entry below. Every phase in this document was complete at
that point. What remained (ratchet rotation, send-side HMU, retry-driven
window shrink, propagation-node interop with an end-user client) was left as
real, separable follow-up work rather than a gap in what this document set
out to close — see Part 1 below for that follow-up.

## Part 1 — production readiness pass

A later pass closed the four items left open at the end of Phase 8 above,
plus re-verified and rewrote the documentation (this file included). Read
first: whichever `RNS`/`LXMF` source file each feature below cites, from a
fresh `pip install --target=/path/to/pylibs rns==1.3.7 lxmf==1.0.1
nomadnet sbapp` — never from memory, same rule as every phase above.

### Feature 1 — send-side HMU + advertisement hashmap truncation

Read `RNS/Resource.py`'s advertisement construction and `hashmap_update_
packet()`. `build_resource_advertisement()` (`shared/rns/protocol.js`) now
truncates `m` to `RESOURCE_HASHMAP_MAX_LEN` entries when a transfer has more
parts than that; `_onResourceRequest()` (`shared/rns/index.js`), on an
exhausted-flagged request, locates the requested segment from the reported
last map hash, validates it lands on a `RESOURCE_HASHMAP_MAX_LEN` boundary,
and sends the next hashmap chunk as a `CONTEXT_RESOURCE_HMU` packet. With
truncation implemented, the constraint that had capped
`RESOURCE_SEGMENT_MAX_SIZE` at a small, hashmap-bound value no longer
applied, so it was raised to match `RNS.Resource.MAX_EFFICIENT_SIZE` (1MiB−1).

Verified: unit tests extended for a JS-to-JS transfer forcing hashmap
truncation and a genuine HMU exchange, plus the multi-segment test rebuilt
around the larger segment size. Live: `test:integration:resource` extended
with a >74-part single-segment case (forcing a real `RNS.Resource` receiver
to send exhausted requests this sender must answer) and a new >1MiB
multi-segment case, both re-run for stability. Committed as `b42f9b4`.

### Feature 2 — retry-driven Resource window shrink

Read `RNS.Resource.__watchdog_job()`'s receiver branch and its
`PART_TIMEOUT_FACTOR`/`_AFTER_RTT`/`MAX_RETRIES`/`RETRY_GRACE_TIME`
constants. Each incoming Resource now tracks `retriesLeft`,
`partTimeoutFactor`, `lastActivity`, and an armed retry timer
(`_armResourceRetry`/`_resourceRetryTick` in `shared/rns/index.js`); a
timeout shrinks the window (and, past a flexibility threshold,
`windowMax`), decrements `retriesLeft`, and re-requests, until either a part
arrives (resetting the retry state) or retries are exhausted (the transfer
is discarded). One documented deviation: retry timing scales by measured
link RTT (floored at 25ms) rather than Python's estimated in-flight transfer
rate — chosen to avoid spurious retries on a low-latency loopback link,
where an RTT-based deadline is more representative than an RNS-style rate
estimate would be this early in a transfer.

Verified: unit tests with a lossy bridge (drops early parts, confirms
recovery with an observed window shrink) and a dead bridge (confirms
discard after `MAX_RETRIES`). Live: `test:integration:resource` and
`:channel` re-verified (no regression on a reliable transport). Committed
as `08d254b`.

### Feature 3 — ratchet rotation

Read `RNS.Destination.rotate_ratchets()`, `RATCHET_COUNT`/`RATCHET_INTERVAL`
(`Destination.py:85,90,227`), and `RNS.Identity.decrypt()`'s retained-ratchet
candidate order (`Identity.py:869`). An IN `Destination` now keeps a
retained ratchet list (newest first, seeded from the identity's own
ratchet) and a `latestRatchetTime`; `announce()` rotates in a fresh ratchet
once `RATCHET_INTERVAL_MS` has elapsed and trims the list to
`RATCHET_COUNT`, before advertising the newest one. `onData()` (and
`propagation.js`'s stored-envelope decrypt) try every retained ratchet
newest-first, then the identity's primary key, matching real RNS's own
fallback order — so a message encrypted against a pre-rotation announce
still decrypts. `saveRatchets()`/`loadRatchets()` persist the retained list
through the existing storage adapter, so a restart doesn't orphan messages
encrypted against a pre-restart ratchet.

Verified: unit tests for rotate-then-decrypt-via-the-old-ratchet,
`RATCHET_COUNT` trimming, and save/load round-tripping across a simulated
restart. Live: `test:integration:lxmf` extended so JS rotates without
re-announcing, confirms a message Python encrypted against the
pre-rotation ratchet still decrypts, then re-announces and confirms
Python's next (post-rotation) message also decrypts (re-run 3× for
stability). Committed as `f326ad5`.

### Feature 4 — propagation-node / end-user-client interop

Two parts.

**4a — a real end-user client and this stack, through a real external
propagation node.** New `test-integration/propagation-node-nomadnet-
interop-check.mjs`: JS uploads via `propagateLXMF()` to a real
`LXMF.LXMRouter` node (`enable_propagation()`); NomadNet (driven by
`nomadnet_driver.py`, extended with `set_propagation_node`/`sync`/
`send_propagated` commands calling the same `message_router` entry points
its own UI uses) syncs it down via `request_messages_from_propagation_
node()`. The reverse direction sends a message from NomadNet via
`handle_outbound(desired_method=PROPAGATED)`, which JS then downloads via
`syncFromRealPropagationNode()`. Found and worked around a real limitation
of this project's own relay in the process: `_forward`/
`_forwardLinkRequest` never rewrite `transport_id`, which a genuine
transport-enabled RNS node's `Transport.packet_filter()` rejects for
non-announce packets when relaying between two *other* real RNS processes
— never exercised before, since every earlier live check had this
project's own `Reticulum` instance as one Link endpoint. Worked around by
giving `lxmf_propagation_node.py` a second `TCPServerInterface`
(`--listen-port`) so NomadNet connects to the node directly rather than
through the JS gateway — sidestepping the gap rather than fixing the
underlying relay limitation, which remains open (see README's Routing
section).

**4b — this project's own `PropagationNode`, wire-compatible with a real
client.** Read `LXMRouter.message_get_request()` (`LXMRouter.py:1426–1504`)
in full: identify()-based auth (the requester's `lxmf.delivery` hash is
derived from the proven identity, not passed in the request), the
list/fetch/purge request shapes, and the cumulative-size accounting for
`transfer_limit_kb`. Implemented as `PropagationNode._onRealGetRequest()`
(`shared/rns/propagation.js`), dispatched from `_onGetRequest()` by request
length (a real client's shapes are 2–3 elements; this project's own
`syncLXMF()` protocol is always 4).

Verified: unit tests — a full JS-to-JS round trip via
`syncFromRealPropagationNode()` (previously only live-tested) against this
project's own node, and direct `/get` calls covering the no-identity error
and `transfer_limit_kb` skip behavior. Live: new `lxmf_propagation_
client.py` (a bare `LXMF.LXMRouter` client, no `enable_propagation()`) and
`test:integration:propagation-client` confirm a real client selects this
project's `PropagationNode` as its outbound propagation node, syncs a
stored message down, validates its signature, and the node purges it once
confirmed (3 consecutive runs). Committed as `e5e88be` (4b) and `4998527`
(4a).

**4a's NomadNet-send/JS-download direction — fixed.** An earlier pass
diagnosed this direction's hang as an unfixable deadlock inside the real,
unmodified `lxmf` package's own `LXStamper.job_linux()` fork()-based stamp
generator. That diagnosis was wrong, and was disproven by verifying
directly against the real `nomadnet` CLI entry point
(`nomadnet.nomadnet:main()`), invoked with no modification: it completes
`LXStamper`'s proof-of-work in a few seconds every time, no matter how
many times it's run. The deadlock only reproduces when the app is driven
by this project's own `test-integration/nomadnet_driver.py`, and only
when that driver dispatches commands via a plain blocking
`for line in sys.stdin: ...` loop.

The mechanism: `_io.BufferedReader.readline()` holds an internal
per-object lock for the duration of a blocked read (CPython releases the
GIL for the underlying read syscall, but not that lock). `LXStamper.
job_linux()` forks its worker pool via
`multiprocessing.get_context("fork").Process(...)` from the router's own
job-scheduler thread. If that fork lands while the driver's stdin-reading
thread holds the buffered-reader lock, the forked child inherits the lock
already held, with no thread in the child able to ever release it —
confirmed live via `/proc/<pid>/stack` showing the worker processes
permanently parked in `futex_wait`. This is a fork-safety hazard in this
driver's own command-dispatch loop, not in the real `lxmf`/`nomadnet`
packages.

Fixed in `nomadnet_driver.py` by reading stdin via `select.select(...,
0.1)` instead of a blocking readline loop, so the driver thread is never
blocked inside the buffered reader's lock while another thread may fork.
`propagation-node-nomadnet-interop-check.mjs` also had an independent,
unrelated bug blocking this same direction: it waited for the real
node's `propagation_entries` store count to reach `>= 2`, assuming the
first (JS-uploaded) message was still present — but the real `LXMRouter`
prunes an entry once a client has synced it, so the store's count drops
back to 0 after NomadNet's sync in the first direction, and never reaches
2. Fixed by tracking store keys instead of a raw count. With both fixes,
`test:integration:propagation-nomadnet` passes both directions,
end-to-end, against a real unmodified `LXMRouter` node and a real
unmodified `nomadnet` client (3 consecutive runs). See README's
Compliance table.

Full regression after all four features: `npm test` (84/84), `npx vite
build`, and the full `test:integration:*` set (including the two new
scripts) re-run clean.

## Status log

| Date | Phase | Result |
|---|---|---|
| 2026-07-05 | Phase 0 | Identity persistence committed (`b3f95fe`); this document created. |
| 2026-07-05 | Phase 1 | Link's RTT-adaptive keepalive/stale/timeout state machine implemented, plus a real bug fix (made `stamp.generate_stamp()`/`generate_peering_key()` non-blocking — see Phase 1 writeup). 51/51 unit tests pass; live `resource`/`channel`/`lxmf-propagation`/`lxmf-peer-sync` checks re-verified. |
| 2026-07-05 | Phase 2.1 | Resource's rate-adaptive request window (growth + fast/very-slow-rate `window_max` promotion/demotion) implemented; retry-driven shrinking scoped out (no per-part retry mechanism exists). 52/52 unit tests pass; live `test:integration:resource` re-verified in both directions. |
| 2026-07-05 | Phase 2.2 | Outgoing bz2 compression implemented for Resource and Buffer via `bzip2-wasm` (a WASM build of the real reference `libbzip2`, chosen over the GPL-licensed `compressjs`). Byte-exact vs real `bz2.compress()`; live checks confirm real `RNS.Resource`/`RNS.Buffer` explicitly recognize JS-compressed transfers; verified working in the actual production browser build via real headless Chromium (a dev-server-only WASM pre-bundling quirk was found and mitigated, doesn't affect the deployed demo). 54/54 unit tests pass. |
| 2026-07-05 | Phase 2.3 | Resource HMU (hashmap update) receive path implemented — this project's receiver can now complete a transfer whose advertisement doesn't include the whole hashmap upfront, matching real RNS's `HASHMAP_MAX_LEN`-based truncation exactly. Send-side truncation/HMU-response scoped out (nothing currently needs it). 57/57 unit tests pass; live `test:integration:resource` confirms a genuine HMU exchange with a real ~87-part `RNS.Resource` sender (re-verified twice). Phase 2 (Resource parity) was complete at that point (send-side HMU and retry-driven window shrink were added later — see README#compliance). |
| 2026-07-05 | Phase 3 | Request/Response Resource fallback implemented for oversized payloads in both directions, matching `RNS.Link.request()`'s own fallback exactly (including its distinct `request_id` hash for the Resource form). 59/59 unit tests pass; live `test:integration:lxmf-propagation` extended to force a real, unmodified `LXMRouter`'s own `/get` response over `LINK_MDU` (4 uploaded messages) and confirms it downloads correctly via the new fallback (re-run 3× for stability). Full regression clean: unit tests, `vite build`, `resource`/`channel` live checks. |
| 2026-07-06 | Phase 4 | Transport parity implemented: `requestPath()` throttling (`PATH_REQUEST_MI`), a persistent per-instance transport identity powering the 3-field path request form (previously 2-field only), path table expiry (`DESTINATION_TIMEOUT`), and an announce rate table mechanism (unenforced, matching RNS's own default-off `announce_rate_target`). Path-request rebroadcast grace and `LOCAL_REBROADCASTS_MAX` scoped out (LAN-collision-avoidance optimizations tied to RNS's announce-table retry machinery, not needed for correctness or interop). 62/62 unit tests pass; new live `test:integration:path-request` confirms a real, unmodified `rns` process's `path_request_handler()` correctly parses and answers the new 3-field form, and that repeat requests are suppressed (re-run 3× for stability). Full regression clean: unit tests, `vite build`, sparse-mesh live check. |
| 2026-07-06 | Phase 5.1 | LXMF DIRECT delivery implemented (`Link.sendLXMF()`, packet or Resource, matching `LXMessage.pack()`'s own representation choice) — corrected a mistake in this plan's own original wording along the way (DIRECT keeps the destination-hash prefix; OPPORTUNISTIC is the one that omits it, confirmed by reading `LXMessage.__as_packet()` and capturing a real `.pack()` byte vector). 66/66 unit tests pass; live `lxmf-cross-language-check.mjs` extended to exchange DIRECT messages with a real, unmodified `lxmf`/`rns` process in both directions and both packet/Resource representations (re-run 3× for stability). Full regression clean: unit tests, `vite build`, `resource`/`lxmf-propagation`/`lxmf-peer-sync` live checks. |
| 2026-07-06 | Phase 5.2 | LXMF delivery announce app_data (`lxmf_build_announce_app_data`/`lxmf_stamp_cost_from_app_data`/`lxmf_compression_supported`, byte-exact) and compression negotiation implemented — `Link.sendLXMF()` skips compression for a Resource-sized message when the recipient's cached announce explicitly declares no `SF_COMPRESSION` support. 69/69 unit tests pass; live `lxmf-cross-language-check.mjs` extended so a real, unmodified `rns`/`lxmf` process re-announces declaring no compression support, and JS's next oversized DIRECT send is confirmed (via the real `RNS.Resource`'s own `compressed` attribute on the Python side) to have honored it (re-run 3× for stability). Full regression clean: unit tests, `vite build`. |
| 2026-07-06 | Phase 5.3 | Propagation-node announce app_data implemented (`lxmf_build_propagation_announce_app_data`/`lxmf_parse_propagation_announce_app_data`, byte-exact, including catching a would-be integer-vs-string msgpack key mismatch before it could break interop). `PropagationNode.announce()` now embeds real stamp/peering cost; `propagateLXMF()`/`syncToPeer()` default to reading it from a cached announce instead of a required argument. 73/73 unit tests pass; both propagation live checks extended to make a real `LXMRouter` fire its actual `announce_propagation_node()` (~20s delay) and drive JS's uploads/peer-sync using *only* the parsed real announce, cross-checked against the test harness's own values (re-run twice each for stability). Full regression clean: unit tests, `vite build`, `lxmf`/`resource`/`channel` live checks. Phase 5 (LXMF outbound parity) was complete. |
| 2026-07-06 | Phase 6 | End-user client interop verified live against real, unmodified `nomadnet` and `sbapp` (Sideband) installs, both directions, both message directions confirmed via each client's own real code paths (`NomadNetworkApp`'s real disk storage / `message_router.handle_outbound()`; `SidebandCore`'s real `send_message()`/delivery callback). Corrected this plan's own assumption that Sideband would be infeasible headless — its daemon mode never imports Kivy at all, confirmed by actually running it. No code changes to `shared/rns/*` (investigation + test-integration only); 73/73 unit tests and `vite build` unaffected and still clean. |
| 2026-07-06 | Phase 7 | Persistence parity implemented as an adaptation: `shared/rns/storage.js`'s `NodeFileStorage` plus `Reticulum`/`PropagationNode` `saveState()`/`loadState()`, wired opt-in into `node/index.js` via `RNS_STORAGE_DIR`. Ratchet rotation explicitly scoped out (a real, separable gap, large enough to warrant its own future phase rather than a shallow fit here). 77/77 unit tests pass (new `test/storage.test.js` covers round-tripping across a simulated restart and stale-file cleanup); `vite build` confirms the Node-only storage module isn't pulled into the browser bundle. This closed every phase in this document except final docs polish (Phase 8). |
| 2026-07-06 | Phase 8 | Docs finalization: swept every checklist row (none left MISSING/UNTESTED), rewrote README's intro/summary/limitations sections against the finished checklist, and fixed five stale code comments left over from before Phases 1–5 landed (a "fixed-size window" note on the now-rate-adaptive Resource receiver, a "no outgoing compression" note, an "out of band" note on propagation stamp cost that Phase 5.3 made announce-derived, a "fallback is not implemented" note on the Phase-3 Request/Response Resource fallback, and a stale "LINKREQUEST packets aren't forwarded" README paragraph). 77/77 unit tests pass, `vite build` clean, spot-checked live integration suite still green. Every phase in this document was complete. |
| 2026-07-09 | Part 1, Feature 1 | Send-side HMU (advertisement hashmap truncation + HMU response) implemented; `RESOURCE_SEGMENT_MAX_SIZE` raised to match real RNS's `MAX_EFFICIENT_SIZE` (1MiB−1) now that truncation removes the constraint that had capped it. Unit tests extended (truncation + HMU-sent assertions, multi-segment test rebuilt around the larger size); live `test:integration:resource` extended with a >74-part single-segment case and a new >1MiB multi-segment case (re-run 3×). Committed as `b42f9b4`. |
| 2026-07-09 | Part 1, Feature 2 | Retry-driven Resource window shrink implemented (per-part retry/timeout matching `RNS.Resource.__watchdog_job()`'s receiver branch, with a documented RTT-vs-estimated-rate scaling deviation). Unit tests added (lossy-bridge recovery-with-shrink, dead-bridge exhaustion-after-`MAX_RETRIES`); live `resource`/`channel` re-verified with no regression. Committed as `08d254b`. |
| 2026-07-09 | Part 1, Feature 3 | Ratchet rotation implemented (`Destination._rotateRatchets`/`saveRatchets`/`loadRatchets`, decrypt-fallback trying every retained ratchet). 84/84 unit tests pass (new rotation/trim/persistence tests); live `test:integration:lxmf` extended to confirm both a stale-ratchet and a fresh-ratchet message decrypt correctly against a real Python identity (3 consecutive runs). Committed as `f326ad5`. |
| 2026-07-09 | Part 1, Feature 4 | Propagation-node/client interop closed on both fronts: `PropagationNode._onRealGetRequest()` makes this project's own node wire-compatible with a real LXMF client's sync protocol (committed as `e5e88be`), and a new live check confirms a real NomadNet client and this stack exchanging messages through a real external `LXMRouter` propagation node, with a real relay limitation (`transport_id` not rewritten when forwarding between two other real RNS processes) found and worked around (committed as `4998527`). One direction of the new check (NomadNet's own PROPAGATED send) is implemented and was observed correctly invoking real proof-of-work, but wasn't exercised to completion in this environment due to how long that PoW takes in pure Python — see the Part 1 writeup and README's Compliance table. 84/84 unit tests pass; `npx vite build` and the full `test:integration:*` set re-run clean. |
| 2026-07-09 | Part 1, follow-up | Root-caused the Feature 4 gap precisely instead of leaving it at "takes a long time": `/proc/<pid>/stack` on the real `LXStamper.job_linux()` worker processes during a live run shows them permanently blocked in `futex_wait`, not computing — a fork-after-multithreading deadlock in the real `lxmf` package's own multiprocessing-based stamp generator, reproducible only with a real `NomadNetworkApp` (real TCP interface, real Link, its own job-loop thread) already running at fork time; isolated minimal repros (background threads, or a bare `RNS.Reticulum`+`LXMRouter` with no interface) complete in 1–5s every time. Not fixable without patching the real, unmodified package. Also closed the item-9 verification gap: every wired `test:integration:*` script (11 total, including `sparse-mesh` with `npm run dev` up) re-run individually and green, not just a 3-script spot check. README/compliance.md updated with the sharper diagnosis. |
| 2026-07-09 | Part 1, correction | The prior entry's diagnosis was wrong, found by verifying directly against the real `nomadnet` CLI entry point (`nomadnet.nomadnet:main()`) as requested: it completes `LXStamper`'s PoW in a few seconds every time, with no modification. The deadlock only reproduces when driven by this project's own `nomadnet_driver.py`, specifically its blocking `for line in sys.stdin: ...` command-dispatch loop — a fork-safety hazard in that driver's own code (a buffered-reader lock held across a `fork()` on another thread), not in the real `lxmf`/`nomadnet` packages. Fixed by switching the driver to a `select()`-based non-blocking stdin poll. `propagation-node-nomadnet-interop-check.mjs` had an independent bug in the same direction (asserted the node's store count reached `>= 2`, not accounting for the real `LXMRouter` pruning a synced entry back out), fixed by tracking store keys instead. `test:integration:propagation-nomadnet` now passes both directions end-to-end (3 consecutive full runs). No bug report filed against `lxmf`/`nomadnet` — the earlier diagnosis that would have justified one didn't hold up. README/compliance.md corrected. |
