#!/usr/bin/env python3
"""A real LXMF propagation node (LXMF.LXMRouter with enable_propagation()),
for testing this repo's JS propagation.js against the actual reference
implementation. Driven over stdin/stdout as newline-delimited JSON, same
convention as rns_node.py.

Requires the real `rns` and `lxmf` packages (pip install rns lxmf).

Commands (stdin):
  {"cmd": "check_store"}

Events (stdout):
  {"event": "ready", "dest_hash": "<hex>", "public_key": "<hex>",
   "propagation_stamp_cost": N, "propagation_stamp_cost_flexibility": N}
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
    args = parser.parse_args()

    import os
    os.makedirs(args.configdir, exist_ok=True)
    config_path = os.path.join(args.configdir, "config")
    if not os.path.isfile(config_path):
        interfaces = ""
        if args.tcp_target_host and args.tcp_target_port:
            interfaces = f"""
[[Bridge]]
  type = TCPClientInterface
  interface_enabled = True
  target_host = {args.tcp_target_host}
  target_port = {args.tcp_target_port}
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
    router = LXMF.LXMRouter(identity=identity, storagepath=args.configdir)
    router.enable_propagation()

    emit(
        "ready",
        dest_hash=router.propagation_destination.hash.hex(),
        public_key=identity.get_public_key().hex(),
        propagation_stamp_cost=router.propagation_stamp_cost,
        propagation_stamp_cost_flexibility=router.propagation_stamp_cost_flexibility,
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
