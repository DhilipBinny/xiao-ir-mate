"""Read or change the IR Mate over the ESPHome native API.

Set IRMATE_HOST to the device's IP or mDNS name, then from the project root:
  export IRMATE_HOST=192.168.1.50
  uv run --python 3.12 --with aioesphomeapi --with pyyaml python -I scripts/device.py status
  uv run ... python -I scripts/device.py set-time "AC auto-off time" 07:00
  uv run ... python -I scripts/device.py set-number "AC auto-on temperature" 25
  uv run ... python -I scripts/device.py press "Sleep timer 2h"
"""

import asyncio
import os
import sys
from pathlib import Path

import aioesphomeapi
import yaml

PORT = 6053
STATE_WAIT_S = 3
SECRETS = Path(__file__).resolve().parent.parent / "secrets.yaml"


def api_key() -> str:
    return yaml.safe_load(SECRETS.read_text())["api_key"]


def format_state(state) -> str:
    if state is None:
        return "(button)"
    if hasattr(state, "hour"):
        return f"{state.hour:02}:{state.minute:02}"
    if hasattr(state, "target_temperature"):
        return f"mode={state.mode.name} target={state.target_temperature}"
    return str(getattr(state, "state", state))


async def main(argv: list[str]) -> int:
    host = os.environ.get("IRMATE_HOST")
    if not argv or not host:
        print(__doc__)
        return 1
    cli = aioesphomeapi.APIClient(host, PORT, None, noise_psk=api_key())
    await cli.connect(login=True)
    try:
        entities, _ = await cli.list_entities_services()
        by_name = {e.name: e for e in entities}
        cmd, args = argv[0], argv[1:]
        if cmd == "set-time":
            hour, minute = (int(v) for v in args[1].split(":"))
            cli.time_command(by_name[args[0]].key, hour, minute, 0)
        elif cmd == "set-number":
            cli.number_command(by_name[args[0]].key, float(args[1]))
        elif cmd == "press":
            cli.button_command(by_name[args[0]].key)
        elif cmd != "status":
            print(f"Unknown command: {cmd}")
            return 1
        states = {}
        cli.subscribe_states(lambda s: states.__setitem__(s.key, s))
        await asyncio.sleep(STATE_WAIT_S)
        for name, entity in sorted(by_name.items()):
            print(f"  {name:38} {format_state(states.get(entity.key))}")
    finally:
        await cli.disconnect()
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1:])))
