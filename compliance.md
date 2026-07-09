# Compliance execution log

Historical execution log for the RNS/LXMF parity work on this project — what was
implemented and verified, in order. The canonical, current feature-parity table is
[README#compliance](./README.md#compliance); this file isn't updated as that table
changes further. Read it for why something was scoped out or what a live check
actually exercises.

## Ground rules

Verified against the real packages, never from memory:

```bash
pip install --target=/path/to/pylibs rns==1.3.7 lxmf==1.0.1
```

Read `pylibs/RNS/` / `pylibs/LXMF/` before implementing or citing anything.

**Verification ladder**, in order of preference:

1. **Byte-exact unit tests** (`test/rns-compliance.test.js`, `test/lxmf-compliance.test.js`)
   whenever a wire format is involved — ground-truth bytes captured from the real
   package with a fixed identity/timestamp.
2. **Live cross-language checks** (`test-integration/*-cross-language-check.mjs`), a
   real Python `rns`/`lxmf` process over real TCP: `PYLIBS=/path/to/pylibs npm run
   test:integration:<name>`. Re-run 2–3× — PoW/timing has real variance.
3. **Full regression** before every commit: `npm test`, `npx vite build`, and the
   integration checks touching the changed layer.

**Process.** Update README's Compliance table, commit, push after each step. No PR
unless asked.

**Sandbox note.** Public Nostr relays are blocked by the environment's egress proxy —
browser-demo verification uses an in-page loopback `Interface` bridging two
`Reticulum` instances, driven by Playwright. `pip` works through the proxy.

## Execution phases

Executed in order; each ended with the full regression suite green and a commit.

### Phase 0 — housekeeping

Committed the sessionStorage identity persistence (`browser/main.js`,
`browser/index.html`). `b3f95fe`.

### Phase 1 — Link timing parity

Replaced fixed 15s/30s timers with real RNS's state machine in `shared/rns/index.js`'s
`Link`: ported `RNS/Link.py:75–108`'s constants (`KEEPALIVE_MIN/MAX`,
`KEEPALIVE_MAX_RTT`, `STALE_FACTOR`, `STALE_GRACE`, `KEEPALIVE_TIMEOUT_FACTOR`,
`ESTABLISHMENT_TIMEOUT_PER_HOP`); replaced fixed timers with a rescheduling watchdog
(`_watchdogTick`, chained `setTimeout` in place of a per-link polling thread):
PENDING/HANDSHAKE → hop-scaled establishment timeout; ACTIVE → keepalive when idle,
STALE when idle past `stale_time`, teardown (`TIMEOUT`) after
`rtt × KEEPALIVE_TIMEOUT_FACTOR + STALE_GRACE`; any inbound while STALE recovers to
ACTIVE. `_updateKeepalive()` computes `keepalive`/`stale_time` from measured RTT once
both sides know it. `_teardown()` now also rejects pending `Link.request()` calls.

**Bug found along the way:** `stamp.generate_stamp()` was a tight synchronous PoW
loop; under the old fixed keepalive this was harmless, but a correctly-short
keepalive on a fast link let a long synchronous stamp computation starve the event
loop long enough for a compliant peer to legitimately time the link out. Fixed by
making `generate_stamp()`/`generate_peering_key()` async, yielding every ~15ms
(real `LXStamper` avoids this by searching in separate processes).

Verified: unit tests (keepalive-formula vectors, STALE transition/recovery, teardown,
driven via back-dated timestamps rather than real waiting). Live:
`resource`/`channel`/`lxmf-propagation`/`lxmf-peer-sync` re-verified.

### Phase 2 — Resource parity

**2.1 Rate-adaptive window (growth; shrink added later — Part 1 Feature 2).**
`Link._growResourceWindow()`/`_requestNextResourceParts()`/`_onResourcePart()`
(`shared/rns/index.js`): each incoming Resource tracks `window`/`windowMax`/`windowMin`
per `Resource.py:58–99`; on each satisfied round, `window` grows toward `windowMax`
(with `windowMin` creeping up past `RESOURCE_WINDOW_FLEXIBILITY`), and round
throughput promotes/demotes `windowMax` between `WINDOW_MAX_SLOW/_FAST/_VERY_SLOW`
per `Resource.py:900–924`. Retry-driven shrink scoped out for this step — no
per-part timeout/retry existed yet to attach it to.

Verified: unit test (30-part transfer, monotonic window growth). Live:
`test:integration:resource` both directions, including a real multi-segment sender.

**2.2 Outgoing bz2 compression.** Used `bzip2-wasm` (WASM build of the real
`libbzip2`, permissive license) over `compressjs` (GPL, rejected on licensing).
`shared/rns/compression.js`: `bz2_compress()`/`bz2_compress_if_beneficial()` match
`Resource.py:384–421`'s policy (compress up to `AUTO_COMPRESS_MAX_SIZE`, use only if
smaller); wired into `Link._sendResourceSegment()` and `buffer.js`'s
`RawChannelWriter.write()` (now async).

Known dev-server-only quirk: `bzip2-wasm`'s asset resolution doesn't survive Vite's
dependency pre-bundling cleanly (`vite.config.js` excludes it); doesn't affect the
deployed demo (verified in a real production build under headless Chromium).

Verified: byte-exact vs `bz2.compress()`; live `test:integration:resource`
(`compressed` flag matches on both compressible and high-entropy input) and
`:channel`; a real headless-Chromium run of the production bundle.

**2.3 HMU receive path (send side added later — Part 1 Feature 1).**
`CONTEXT_RESOURCE_HMU=0x04`, `RESOURCE_HASHMAP_MAX_LEN` (= 74 at default MTU, matching
`ResourceAdvertisement.HASHMAP_MAX_LEN`), exhausted-request and HMU packet
round-trip in `shared/rns/protocol.js`; `shared/rns/index.js`'s
`_onResourceAdvertisement`/`_requestNextResourceParts`/`_onHashmapUpdate` handle a
truncated advertisement, exhausted requests, and applying HMU chunks. Send side
(this project's own sender always sent the full hashmap) deferred — both a real and
this project's own receiver already tolerate that.

Verified: unit tests (wire round-trip + a hand-truncated 3-of-7-entry transfer).
Live: `test:integration:resource` — a real ~87-part `RNS.Resource` sender correctly
truncates and this receiver completes via HMU (re-run twice).

### Phase 3 — Request/Response Resource fallback

Per `RNS/Link.py:473–508` (request) and `:842–850` (response): a packed
request/response exceeding `LINK_MDU` goes as a Resource instead, tagged with a
`request_id` (`resource_request_id()` in `protocol.js` — a hash of the payload
itself, distinct from the single-packet path's outer-packet hash).
`build/parse_resource_advertisement()` carry the `request_id` and `is_request`/
`is_response` flags. `Link.request()`/`_handleRequest()` (`shared/rns/index.js`)
pick Resource vs packet by size; `_assembleResource()` routes a completed Resource
by its request/response flags instead of emitting a generic event.

Verified: unit tests (advertisement round-trip, forced Resource-path request/response
both directions). Live: `test:integration:lxmf-propagation` uploads 4 messages to a
real `LXMRouter` node so its `/get` response exceeds `LINK_MDU`, exercising the real
oversized-response path; all 4 downloaded byte-exact (re-run 3×).

### Phase 4 — Transport parity

Per `RNS/Transport.py`'s path-request/announce-rate handling, in
`shared/rns/index.js`'s `Reticulum`:

1. **Path-request throttling** — `requestPath()` suppresses a repeat call for the
   same destination within `PATH_REQUEST_MI_MS` (20s, applied directly at the public
   call site rather than RNS's internal retry-only scope, since this project has no
   such background retry loop).
2. **Transport instance identity + 3-field path requests** — every instance creates
   a persistent `transportIdentity`; since this project's mesh nodes always forward
   for destinations they don't own, the 3-field form (`dest + transport_id + tag`) is
   used unconditionally rather than gated behind an explicit toggle.
3. **Path table expiry** — hourly job drops entries untouched past
   `DESTINATION_TIMEOUT_MS` (7 days).
4. **Announce rate table** — timestamps recorded per destination
   (`MAX_RATE_TIMESTAMPS=16`), left unenforced, matching RNS's own default-off
   `announce_rate_target`.

Scoped out: `PATH_REQUEST_GRACE`/`LOCAL_REBROADCASTS_MAX` — LAN-collision-avoidance
optimizations tied to RNS's announce-table retry machinery this project's flood-based
mesh has no natural home for; don't affect correctness.

Verified: unit tests (3-field throttling, path-table cleanup, rate-table cap). Live:
new `test:integration:path-request` — a real `rns` process's `path_request_handler()`
parses/answers the 3-field form and suppresses a repeat request (re-run 3×).

### Phase 5 — LXMF outbound parity

**5.1 DIRECT delivery.** Per `LXMessage.py:355–460`/`:626–654`: DIRECT keeps the
full `destination_hash + source_hash + signature + payload` layout over the Link;
OPPORTUNISTIC is the one that omits the destination hash (implied by the packet's
own addressing). `protocol.js`'s `lxmf_build_direct/lxmf_parse_direct` implement the
4-field form; `Link.sendLXMF()` (`shared/rns/index.js`) picks packet vs Resource by
size, matching `LXMessage.pack()`; receive side tries `tryParseLxmfDirect()` before
falling back to `'packet'`/`'resource'`.

Verified: unit tests (byte-exact wire form, signature rejection, packet/Resource
JS-to-JS). Live: `rns_node.py` extended with a Link-scoped LXMF callback;
`lxmf-cross-language-check.mjs` exchanges DIRECT both directions/representations
(re-run 3×).

**5.2 Delivery announce app_data + compression negotiation.** Per
`LXMRouter.get_announce_app_data()`/`LXMessage.determine_compression_support()`:
`lxmf_build_announce_app_data()` builds `[display_name, stamp_cost,
[SF_COMPRESSION]]` (byte-exact); `lxmf_stamp_cost_from_app_data()`/
`lxmf_compression_supported()` parse it, including the case where app_data is
present but omits `SF_COMPRESSION` (returns false — only *no* app_data defaults
true). `Destination.announce()` gained an `appData` option; `Link.sendLXMF()` skips
compression when the recipient's cached announce says no support.

Verified: unit tests (byte-exact round-trip, no-compression-support parsing, sent
advertisement's own flag). Live: `lxmf-cross-language-check.mjs` — a real `rns`
process announces no compression support and JS's next send honors it, confirmed via
the real `RNS.Resource.compressed` attribute (re-run 3×).

**5.3 Propagation-node announce app_data.** Per
`LXMRouter.get_propagation_node_app_data()`/`LXMF.pn_announce_data_is_valid()`:
`lxmf_build_propagation_announce_app_data()` builds the 7-element form (byte-exact,
including the metadata dict's integer-keyed entry — needed a `Map`, since a plain JS
object coerces keys to strings). `PropagationNode.announce()` embeds real
stamp/peering cost; `propagateLXMF()`/`syncToPeer()` default to reading cost from the
destination's cached announce rather than a required argument.

Verified: unit tests (byte-exact match, validation rules, cost read from a real
announce). Live: both propagation checks extended to wait for `LXMRouter`'s real
`announce_propagation_node()` (~20s) and drive uploads/sync from the parsed announce
alone (re-run twice each). Phase 5 complete.

### Phase 6 — end-user client interop

**NomadNet.** `pip install --target=$PYLIBS nomadnet`. `-d`/`--daemon` mode never
touches its TUI, and `Conversation.py` calls `app.message_router.handle_outbound(lxm)`
directly for sending — so `test-integration/nomadnet_driver.py` drives a real
`NomadNetworkApp` (constructed the same way `nomadnet -d` does) and calls the same
router method. Verified both directions: JS's OPPORTUNISTIC send lands in NomadNet's
own on-disk conversation store; NomadNet's own outbound call is received and
validated by this stack. NomadNet's real announce app_data parses correctly,
cross-checked against its own configured display name.

**Sideband.** `pip install --target=$PYLIBS sbapp`. Its Kivy/KivyMD import block is
gated behind `if not args.daemon:`, so `-d` mode never imports Kivy — confirmed by
running it with no virtual display. `SidebandCore(...).start()` returns normally, so
`test-integration/sideband_driver.py` calls it directly with a delivery-callback
wrapper. Sending uses Sideband's own `send_message()`, which defaults to DIRECT
(exercising Phase 5.1 against a real client, not just bare `lxmf`). Verified both
directions (re-run 3× each).

Not attempted: propagation-node interop with either client (Phase 5.3 already covers
the propagation wire format against the reference implementation directly).

### Phase 7 — persistence parity (adaptation scope)

`shared/rns/storage.js`'s `NodeFileStorage` (Node-only, one-file-per-key, msgpack)
plus `saveState()`/`loadState()` on `Reticulum` (identity cache + path table) and
`PropagationNode` (message store). Wired opt-in via `RNS_STORAGE_DIR` in
`node/index.js`: loads on startup, saves every 5 minutes and on SIGINT/SIGTERM. No
browser adapter — the demo's sessionStorage identity caching already covers what's
worth persisting there.

Limitation: a reloaded path-table entry can answer a path request but can't serve as
a `_forward()` next-hop (interface/peer object references aren't serializable) until
a live announce refreshes it.

Scoped out: ratchet rotation (`RNS.Destination.rotate_ratchets`) — a real, separable
gap independent of persistence, large enough to warrant its own phase (see Part 1
Feature 3).

Verified: unit tests (`NodeFileStorage` round-trip, `Reticulum`/`PropagationNode`
save/load across a simulated restart, stale-file cleanup). `vite build` confirms
`storage.js` isn't pulled into the browser bundle.

### Phase 8 — docs finalization

Swept every checklist row (none left MISSING/UNTESTED); rewrote README's intro and
limitations sections; fixed five stale code comments left over from before Phases
1–5 (window/compression/stamp-cost/fallback notes, and a stale
"LINKREQUEST packets aren't forwarded" paragraph predating `_forwardLinkRequest`).
Full regression clean. Every phase in this document was complete; what remained
(ratchet rotation, send-side HMU, retry-driven window shrink, propagation-node/
client interop) continued as Part 1 below.

## Part 1 — production readiness pass

Closed the four items left open at the end of Phase 8, then re-verified and rewrote
the documentation. Same ground rules as above — read the Python source fresh each
time (`pip install --target=/path/to/pylibs rns==1.3.7 lxmf==1.0.1 nomadnet sbapp`).

### Feature 1 — send-side HMU + advertisement hashmap truncation

Per `RNS/Resource.py`'s advertisement construction and `hashmap_update_packet()`:
`build_resource_advertisement()` truncates `m` to `RESOURCE_HASHMAP_MAX_LEN` entries
past that many parts; `_onResourceRequest()`, on an exhausted-flagged request, sends
the next hashmap chunk as `CONTEXT_RESOURCE_HMU`. With truncation implemented,
`RESOURCE_SEGMENT_MAX_SIZE` was raised to match `MAX_EFFICIENT_SIZE` (1MiB−1).

Verified: unit tests (forced truncation + HMU exchange, multi-segment test rebuilt
around the larger size). Live: `test:integration:resource` extended with a >74-part
single-segment case and a >1MiB multi-segment case. `b42f9b4`.

### Feature 2 — retry-driven Resource window shrink

Per `Resource.__watchdog_job()`'s receiver branch and its `PART_TIMEOUT_FACTOR`/
`_AFTER_RTT`/`MAX_RETRIES`/`RETRY_GRACE_TIME`: each incoming Resource tracks
`retriesLeft`/`partTimeoutFactor`/`lastActivity` and an armed retry timer
(`_armResourceRetry`/`_resourceRetryTick`); a timeout shrinks the window, decrements
retries, and re-requests, until a part arrives or retries exhaust (transfer
discarded). Deviation: retry timing scales by measured RTT (floored 25ms) rather
than Python's estimated in-flight rate, to avoid spurious retries on a low-latency
loopback link.

Verified: unit tests (lossy-bridge recovery-with-shrink, dead-bridge exhaustion).
Live: `resource`/`channel` re-verified, no regression. `08d254b`.

### Feature 3 — ratchet rotation

Per `Destination.rotate_ratchets()`, `RATCHET_COUNT`/`RATCHET_INTERVAL`
(`Destination.py:85,90,227`), and `Identity.decrypt()`'s retained-ratchet order: an IN
`Destination` keeps a retained ratchet list (newest first) and rotates a fresh one
into `announce()` once `RATCHET_INTERVAL_MS` has elapsed, trimming to
`RATCHET_COUNT`. `onData()` tries every retained ratchet newest-first, then the
identity's primary key. `saveRatchets()`/`loadRatchets()` persist the list through
the existing storage adapter.

Verified: unit tests (rotate-then-decrypt-via-old-ratchet, trim, save/load
round-trip). Live: `test:integration:lxmf` — a pre-rotation message still decrypts,
a post-rotation one also decrypts (re-run 3×). `f326ad5`.

### Feature 4 — propagation-node / end-user-client interop

**4a — a real end-user client and this stack, through a real external propagation
node.** New `propagation-node-nomadnet-interop-check.mjs`: JS uploads via
`propagateLXMF()` to a real `LXMRouter` node; NomadNet (driven by `nomadnet_driver.py`,
extended with `set_propagation_node`/`sync`/`send_propagated`) syncs it down via
`request_messages_from_propagation_node()`. Reverse: NomadNet sends
`PROPAGATED`, JS downloads via `syncFromRealPropagationNode()`.

Found and worked around a real relay limitation along the way: `_forward`/
`_forwardLinkRequest` don't rewrite `transport_id`, which a genuine transport-enabled
RNS node's `packet_filter()` rejects for non-announce packets when relaying between
two *other* real RNS processes (never exercised before — every earlier check had
this project's own instance as a Link endpoint). Workaround: `lxmf_propagation_
node.py` gained a second `TCPServerInterface` so NomadNet connects to the node
directly rather than through the JS gateway; the underlying relay limitation remains
open (see README's Routing section).

**4b — this project's own `PropagationNode`, wire-compatible with a real client.**
Per `LXMRouter.message_get_request()` (`:1426–1504`): identify()-based auth, the
list/fetch/purge request shapes, `transfer_limit_kb` accounting. Implemented as
`PropagationNode._onRealGetRequest()`, dispatched by request length (a real client's
shapes are 2–3 elements; this project's own `syncLXMF()` is always 4).

Verified: unit tests (full JS-to-JS round trip via `syncFromRealPropagationNode()`,
no-identity error, `transfer_limit_kb` skip). Live: new `lxmf_propagation_client.py`
(bare `LXMRouter`, no `enable_propagation()`) and `test:integration:propagation-client`
confirm a real client syncs from and gets purged by this project's node (3 runs).
`e5e88be` (4b), `4998527` (4a).

**4a's NomadNet-send/JS-download direction.** An earlier pass diagnosed this
direction's hang as an unfixable deadlock inside the real `lxmf` package's own
`LXStamper.job_linux()`. That diagnosis was wrong: verified directly against the
real `nomadnet` CLI entry point (`nomadnet.nomadnet:main()`), unmodified, `LXStamper`
completes its PoW in a few seconds every time. The deadlock only reproduces when
driven by this project's own `nomadnet_driver.py`, and only because of its blocking
`for line in sys.stdin: ...` command-dispatch loop.

Mechanism: `_io.BufferedReader.readline()` holds an internal per-object lock for the
duration of a blocked read (CPython releases the GIL, not that lock).
`LXStamper.job_linux()` forks its worker pool via `multiprocessing.get_context
("fork")` from the router's own job-scheduler thread; if that fork lands while the
driver's stdin thread holds the lock, the forked child inherits it locked with no
thread able to release it — confirmed via `/proc/<pid>/stack` showing the workers
permanently parked in `futex_wait`. A fork-safety bug in this driver's own loop, not
in `lxmf`/`nomadnet`.

Fixed by reading stdin via `select.select(..., 0.1)` instead of blocking on it.
`propagation-node-nomadnet-interop-check.mjs` had an independent bug in the same
direction: it waited for the node's store count to reach `>= 2`, not accounting for
`LXMRouter` pruning an entry once synced (the count drops back to 0 after the first
direction's sync); fixed by tracking store keys instead. `test:integration:
propagation-nomadnet` now passes both directions end-to-end (3 consecutive runs). No
bug report was warranted against `lxmf`/`nomadnet`.

Full regression after all four features: `npm test` (84/84), `npx vite build`, and
the full `test:integration:*` set clean.

## Status log

| Date | Phase | Commit | Result |
|---|---|---|---|
| 2026-07-05 | Phase 0 | `b3f95fe` | Identity persistence; this document created. |
| 2026-07-05 | Phase 1 | — | Link's RTT-adaptive state machine + non-blocking stamp generation. 51/51 unit tests; `resource`/`channel`/`lxmf-propagation`/`lxmf-peer-sync` re-verified. |
| 2026-07-05 | Phase 2.1 | — | Resource rate-adaptive window (growth). 52/52 unit tests; `resource` re-verified both directions. |
| 2026-07-05 | Phase 2.2 | — | Outgoing bz2 compression via `bzip2-wasm`. 54/54 unit tests; byte-exact + live checks; verified in a real production Chromium build. |
| 2026-07-05 | Phase 2.3 | — | Resource HMU receive path. 57/57 unit tests; live HMU exchange with a real ~87-part sender. Phase 2 complete except send-side HMU/window-shrink (Part 1). |
| 2026-07-05 | Phase 3 | — | Request/Response Resource fallback. 59/59 unit tests; a real `LXMRouter`'s oversized `/get` response downloads correctly (re-run 3×). |
| 2026-07-06 | Phase 4 | — | Transport parity: path-request throttling, 3-field requests, path-table expiry, announce rate table. 62/62 unit tests; new `path-request` live check (re-run 3×). |
| 2026-07-06 | Phase 5.1 | — | LXMF DIRECT delivery. 66/66 unit tests; `lxmf` live check extended both directions/representations (re-run 3×). |
| 2026-07-06 | Phase 5.2 | — | Delivery announce app_data + compression negotiation. 69/69 unit tests; live compression-skip confirmed via real `RNS.Resource.compressed` (re-run 3×). |
| 2026-07-06 | Phase 5.3 | — | Propagation-node announce app_data. 73/73 unit tests; both propagation checks driven from a real parsed announce (re-run twice each). Phase 5 complete. |
| 2026-07-06 | Phase 6 | — | NomadNet/Sideband interop verified live, both directions each. No `shared/rns` changes. |
| 2026-07-06 | Phase 7 | — | Persistence parity (`NodeFileStorage`, opt-in via `RNS_STORAGE_DIR`); ratchet rotation scoped out. 77/77 unit tests. |
| 2026-07-06 | Phase 8 | — | Docs finalization; five stale comments fixed. 77/77 unit tests, `vite build` clean. Every phase in this document complete. |
| 2026-07-09 | Part 1, Feature 1 | `b42f9b4` | Send-side HMU + hashmap truncation; `RESOURCE_SEGMENT_MAX_SIZE` raised to 1MiB−1. Live `resource` extended (>74-part and >1MiB cases, re-run 3×). |
| 2026-07-09 | Part 1, Feature 2 | `08d254b` | Retry-driven Resource window shrink. Live `resource`/`channel` re-verified, no regression. |
| 2026-07-09 | Part 1, Feature 3 | `f326ad5` | Ratchet rotation. 84/84 unit tests; live `lxmf` confirms both stale- and fresh-ratchet decryption (3 runs). |
| 2026-07-09 | Part 1, Feature 4 | `e5e88be`, `4998527` | Propagation-node/client interop closed both ways; found and worked around a real `transport_id` relay limitation. NomadNet-send/JS-download direction observed invoking real PoW but not exercised to completion yet. 84/84 unit tests; full `test:integration:*` clean. |
| 2026-07-09 | Part 1, follow-up | — | Root-caused (at the time) the remaining PoW gap as a fork-after-multithreading deadlock in real `lxmf`'s `LXStamper` — later shown wrong, see next entry. Also re-ran all 11 wired `test:integration:*` scripts individually, green. |
| 2026-07-09 | Part 1, correction | `862be45` | Prior entry's diagnosis was wrong: verified directly against the real `nomadnet` CLI, unmodified — no deadlock. Root cause was `nomadnet_driver.py`'s own blocking stdin loop (a fork-safety bug), fixed via `select()`; a second, unrelated bug in the interop check's store-count assertion also fixed. `test:integration:propagation-nomadnet` passes both directions end-to-end (3 runs). No bug report filed upstream. |
