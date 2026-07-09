#!/usr/bin/env python3
"""A real LXMF propagation node (LXMF.LXMRouter with enable_propagation()),
for testing this repo's JS propagation.js against the actual reference
implementation. Driven over stdin/stdout as newline-delimited JSON, same
convention as rns_node.py.

Requires the real `rns` and `lxmf` packages (pip install rns lxmf).

Commands (stdin):
  {"cmd": "check_store"}

Events (stdout):
  {"event": "ready", "dest_hash": "<hex>", "public_key": "<hex>", "identity_hash": "<hex>",
   "propagation_stamp_cost": N, "propagation_stamp_cost_flexibility": N, "peering_cost": N}
  {"event": "store_status", "count": N, "keys": ["<transient_id hex>", ...]}
"""
import sys
import json
import argparse

import RNS
import LXMF


def emit(event, **fields):
    print(json.dumps({"event": event, **fields}), flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--configdir", required=True)
    parser.add_argument("--tcp-target-host", default=None)
    parser.add_argument("--tcp-target-port", type=int, default=None)
    parser.add_argument("--listen-port", type=int, default=None, help="also bind a TCPServerInterface, so a third real RNS process (e.g. NomadNet) can connect directly rather than through the JS gateway — this project's own packet forwarding is a simplified single-hop analog of RNS.Transport and doesn't rewrite transport_id when relaying, which a real transport-enabled node's packet_filter() rejects for non-announce packets (Transport.py's 'in transport for other transport instance')")
    parser.add_argument("--propagation-cost", type=int, default=None, help="override LXMRouter's default propagation_cost (16) — real LXStamper PoW at the default cost can take many minutes in pure Python; LXMRouter.PROPAGATION_COST_MIN (13) is the lowest it accepts")
    args = parser.parse_args()

    import os
    os.makedirs(args.configdir, exist_ok=True)
    config_path = os.path.join(args.configdir, "config")
    if not os.path.isfile(config_path):
        interfaces = ""
        if args.tcp_target_host and args.tcp_target_port:
            interfaces += f"""
[[Bridge]]
  type = TCPClientInterface
  interface_enabled = True
  target_host = {args.tcp_target_host}
  target_port = {args.tcp_target_port}
"""
        if args.listen_port:
            interfaces += f"""
[[Listener]]
  type = TCPServerInterface
  interface_enabled = True
  listen_ip = 127.0.0.1
  listen_port = {args.listen_port}
"""
        with open(config_path, "w") as f:
            f.write(f"""[reticulum]
enable_transport = True
share_instance = False
panic_on_interface_error = False

[logging]
loglevel = 3

[interfaces]
{interfaces}
""")

    RNS.Reticulum(configdir=args.configdir)

    identity = RNS.Identity()
    router_kwargs = {}
    if args.propagation_cost is not None:
        router_kwargs["propagation_cost"] = args.propagation_cost
    router = LXMF.LXMRouter(identity=identity, storagepath=args.configdir, **router_kwargs)
    router.enable_propagation()
    # Real get_propagation_node_app_data()-carrying announce (Phase 5.3) —
    # fires after LXMRouter.NODE_ANNOUNCE_DELAY (20s), same as any real node.
    router.announce_propagation_node()

    emit(
        "ready",
        dest_hash=router.propagation_destination.hash.hex(),
        public_key=identity.get_public_key().hex(),
        identity_hash=identity.hash.hex(),
        propagation_stamp_cost=router.propagation_stamp_cost,
        propagation_stamp_cost_flexibility=router.propagation_stamp_cost_flexibility,
        peering_cost=router.peering_cost,
    )

    def handle_command(line):
        try:
            cmd = json.loads(line)
        except Exception:
            return

        if cmd.get("cmd") == "check_store":
            emit(
                "store_status",
                count=len(router.propagation_entries),
                keys=[k.hex() for k in router.propagation_entries.keys()],
            )

    for line in sys.stdin:
        line = line.strip()
        if line:
            handle_command(line)


if __name__ == "__main__":
    main()
