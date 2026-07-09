#!/usr/bin/env python3
"""Drives a real, unmodified `nomadnet` (NomadNet) client for interop testing
against this repo's JS stack (compliance.md Phase 6). Requires `pip install
nomadnet` in addition to `rns`/`lxmf`.

NomadNet has no scriptable JSON-RPC control interface (unlike this repo's own
rns_node.py test helper) — it's a TUI application whose NomadNetworkApp
constructor itself runs a blocking job loop once initialized, so this driver:
  1. Constructs NomadNetworkApp(...) directly on the main thread, exactly the
     same call nomadnet.nomadnet:main() (the real `nomadnet` CLI's own entry
     point) makes — same identity file, same LXMRouter, same delivery
     destination, same start-of-day announce after
     NomadNetworkApp.START_ANNOUNCE_DELAY=3s. Nothing about NomadNet's own
     behavior is modified or bypassed. This call blocks forever (it runs the
     daemon's job-scheduler loop synchronously), which is also why it must
     run on the main thread: RNS.Reticulum's constructor registers a SIGINT
     handler, and Python only allows that from the main thread of the main
     interpreter.
  2. A background thread gets a handle to the running instance via
     NomadNetworkApp.get_shared_instance() — a real, public accessor the
     library itself provides for exactly this kind of external access —
     rather than pre-allocating the instance with object.__new__() and
     calling __init__() separately.
  3. Once initialized, sending a message uses LXMF.LXMessage(desired_method=
     OPPORTUNISTIC) directly against NomadNet's own real `message_router`/
     `lxmf_destination` — the same primitives NomadNet's own TUI "compose"
     screen calls internally, just invoked without driving the TUI widget
     tree (headless automation of the TUI itself isn't practical, per
     compliance.md Phase 6 — see README's Compliance section for what this
     means for the interop claim).

Command dispatch reads stdin via select() with a short timeout rather than
a plain blocking `for line in sys.stdin` loop. That distinction matters: a
blocking readline() sits inside `_io.BufferedReader`'s internal per-object
lock for the whole time it waits for input (CPython releases the GIL for
the blocking read syscall itself, but not that lock). Meanwhile, LXMF's
LXStamper.job_linux() spawns its PoW worker pool via
`multiprocessing.get_context("fork").Process(...)` from the router's own
job-scheduler thread — if that fork() lands while this driver's stdin
thread is holding the buffered-reader lock, the child process inherits it
already locked, with no thread in the child able to ever release it,
so any worker that needs it (indirectly, e.g. via stdio) hangs in
futex_wait forever. This was confirmed live, with a real propagation node
and real `python -m nomadnet` process: driving the exact same
NomadNetworkApp construction and handle_outbound() call directly (no
stdin loop at all) always completed the PoW in a few seconds, while the
blocking-stdin-loop version deadlocked every time. The real, unmodified
lxmf/nomadnet packages are not at fault — this is a fork-safety hazard in
this driver's own command-dispatch loop, avoided here by never blocking
inside the buffered stdin reader while other threads may fork().

Commands (stdin, one JSON object per line):
  {"cmd": "send_to", "dest_hash": "<hex>", "title": "...", "content": "..."} — OPPORTUNISTIC, direct
  {"cmd": "set_propagation_node", "dest_hash": "<hex>"} — message_router.set_outbound_propagation_node()
  {"cmd": "sync"} — message_router.request_messages_from_propagation_node(), same call NomadNet's own "Sync now" menu item makes
  {"cmd": "send_propagated", "dest_hash": "<hex>", "title": "...", "content": "..."} — routes via the configured propagation node instead of direct delivery

Events (stdout, one JSON object per line):
  {"event": "ready", "dest_hash": "<hex>", "identity_hash": "<hex>", "public_key": "<hex>", "display_name": "..."}
  {"event": "sync_state", "state": N} — message_router.propagation_transfer_state after each change (LXMRouter.PR_*)
"""
import sys
import json
import time
import select
import argparse
import threading

import RNS
import LXMF
import nomadnet


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configdir", required=True)
    parser.add_argument("--rnsconfigdir", required=True)
    args = parser.parse_args()

    app_holder = {}

    def handle_command(line):
        try:
            cmd = json.loads(line)
        except Exception:
            return

        try:
            dispatch_command(cmd)
        except Exception as e:
            import traceback
            emit("command_error", cmd=cmd.get("cmd"), error=str(e), traceback=traceback.format_exc())

    def dispatch_command(cmd):
        app = app_holder["app"]
        if cmd.get("cmd") == "debug_status":
            emit(
                "debug_status",
                pending_outbound=len(app.message_router.pending_outbound),
                pending_deferred=len(app.message_router.pending_deferred_stamps),
                processing_count=app.message_router.processing_count,
                stamp_gen_locked=app.message_router.stamp_gen_lock.locked(),
                outbound_propagation_node=app.message_router.outbound_propagation_node.hex() if app.message_router.outbound_propagation_node else None,
                outbound_link_status=app.message_router.outbound_propagation_link.status if app.message_router.outbound_propagation_link else None,
            )
        elif cmd.get("cmd") == "send_to":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            peer_identity = RNS.Identity.recall(dest_hash)
            if peer_identity is None:
                emit("send_failed", reason="identity not known")
                return
            peer_dest = RNS.Destination(peer_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, LXMF.APP_NAME, "delivery")
            message = LXMF.LXMessage(
                peer_dest, app.lxmf_destination,
                cmd.get("content", ""), cmd.get("title", ""),
                desired_method=LXMF.LXMessage.OPPORTUNISTIC,
            )
            app.message_router.handle_outbound(message)
        elif cmd.get("cmd") == "set_propagation_node":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            app.message_router.set_outbound_propagation_node(dest_hash)
        elif cmd.get("cmd") == "sync":
            app.message_router.request_messages_from_propagation_node(app.identity, LXMF.LXMRouter.PR_ALL_MESSAGES)
        elif cmd.get("cmd") == "send_propagated":
            dest_hash = bytes.fromhex(cmd["dest_hash"])
            peer_identity = RNS.Identity.recall(dest_hash)
            if peer_identity is None:
                emit("send_failed", reason="identity not known")
                return
            peer_dest = RNS.Destination(peer_identity, RNS.Destination.OUT, RNS.Destination.SINGLE, LXMF.APP_NAME, "delivery")
            message = LXMF.LXMessage(
                peer_dest, app.lxmf_destination,
                cmd.get("content", ""), cmd.get("title", ""),
                desired_method=LXMF.LXMessage.PROPAGATED,
            )
            # Real LXMessage defaults defer_propagation_stamp=True: handle_outbound()
            # queues it in pending_deferred_stamps rather than pending_outbound, and
            # the real router's own background job loop (process_deferred_stamps(),
            # JOB_STAMPS_INTERVAL) generates the actual LXStamper proof-of-work before
            # it becomes sendable — the same path NomadNet's own compose flow uses.
            app.message_router.handle_outbound(message)

    def poll_sync_state():
        app = app_holder["app"]
        last = None
        while True:
            state = app.message_router.propagation_transfer_state
            if state != last:
                emit("sync_state", state=state)
                last = state
            time.sleep(0.1)

    def wait_for_app_and_run():
        # NomadNetworkApp.get_shared_instance() is a real, public accessor
        # the library itself provides for exactly this kind of external
        # scripted access — it raises until the app has been constructed.
        app = None
        while app is None or not hasattr(app, "lxmf_destination"):
            try:
                app = nomadnet.NomadNetworkApp.get_shared_instance()
            except Exception:
                app = None
            time.sleep(0.1)
        app_holder["app"] = app

        emit(
            "ready",
            dest_hash=app.lxmf_destination.hash.hex(),
            identity_hash=app.identity.hash.hex(),
            public_key=app.identity.get_public_key().hex(),
            display_name=app.get_display_name(),
        )

        threading.Thread(target=poll_sync_state, daemon=True).start()

        # select() with a timeout, not a blocking `for line in sys.stdin`
        # loop: see the fork-safety note in the module docstring above.
        while True:
            readable, _, _ = select.select([sys.stdin], [], [], 0.1)
            if not readable:
                continue
            line = sys.stdin.readline()
            if line == "":
                break  # EOF
            line = line.strip()
            if line:
                handle_command(line)

    threading.Thread(target=wait_for_app_and_run, daemon=True).start()

    # NomadNetworkApp(...) constructs its own RNS.Reticulum instance, which
    # registers a SIGINT handler — only valid from the main thread, so this
    # call (which also runs its own blocking job-scheduler loop forever,
    # exactly like a real `nomadnet -d` daemon) must run here rather than in
    # a background thread. This is the exact call nomadnet.nomadnet:main()
    # (the real CLI entry point) makes.
    nomadnet.NomadNetworkApp(configdir=args.configdir, rnsconfigdir=args.rnsconfigdir, daemon=True, force_console=True)


if __name__ == "__main__":
    main()
