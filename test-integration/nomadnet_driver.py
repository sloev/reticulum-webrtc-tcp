#!/usr/bin/env python3
"""Drives a real, unmodified `nomadnet` (NomadNet) client for interop testing
against this repo's JS stack (compliance.md Phase 6). Requires `pip install
nomadnet` in addition to `rns`/`lxmf`.

NomadNet has no scriptable JSON-RPC control interface (unlike this repo's own
rns_node.py test helper) — it's a TUI application whose NomadNetworkApp
constructor itself runs a blocking job loop once initialized, so this driver:
  1. Allocates the NomadNetworkApp instance via object.__new__() so a
     reference exists before __init__ (which blocks) is even called.
  2. Runs __init__() in a background thread — this is the exact same
     initialization a real `nomadnet -d -c` daemon run performs (same
     identity file, same LXMRouter, same delivery destination, same
     start-of-day announce after NomadNetworkApp.START_ANNOUNCE_DELAY=3s) —
     nothing about NomadNet's own behavior is modified or bypassed.
  3. Once initialized, sending a message uses LXMF.LXMessage(desired_method=
     OPPORTUNISTIC) directly against NomadNet's own real `message_router`/
     `lxmf_destination` — the same primitives NomadNet's own TUI "compose"
     screen calls internally, just invoked without driving the TUI widget
     tree (headless automation of the TUI itself isn't practical, per
     compliance.md Phase 6 — see README's Compliance section for what this
     means for the interop claim).

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

    app = object.__new__(nomadnet.NomadNetworkApp)

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
        last = None
        while True:
            state = app.message_router.propagation_transfer_state
            if state != last:
                emit("sync_state", state=state)
                last = state
            time.sleep(0.1)

    def stdin_loop():
        # Poll for the attributes NomadNetworkApp's __init__ sets once its
        # LXMF delivery destination is registered (see NomadNetworkApp.py's
        # register_delivery_identity() call) before announcing readiness.
        while not hasattr(app, "lxmf_destination"):
            time.sleep(0.1)

        emit(
            "ready",
            dest_hash=app.lxmf_destination.hash.hex(),
            identity_hash=app.identity.hash.hex(),
            public_key=app.identity.get_public_key().hex(),
            display_name=app.get_display_name(),
        )

        threading.Thread(target=poll_sync_state, daemon=True).start()

        for line in sys.stdin:
            line = line.strip()
            if line:
                handle_command(line)

    t = threading.Thread(target=stdin_loop, daemon=True)
    t.start()

    # NomadNetworkApp.__init__() constructs its own RNS.Reticulum instance,
    # which registers a SIGINT handler — only valid from the main thread, so
    # __init__() (which also runs its own blocking job-scheduler loop
    # forever, exactly like a real `nomadnet -d` daemon) must run here rather
    # than in a background thread.
    app.__init__(configdir=args.configdir, rnsconfigdir=args.rnsconfigdir, daemon=True, force_console=True)


if __name__ == "__main__":
    main()
