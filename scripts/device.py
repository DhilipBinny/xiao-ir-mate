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
import re
import sys
from pathlib import Path

import aioesphomeapi
import yaml

PORT = 6053
STATE_WAIT_S = 3
SECRETS = Path(__file__).resolve().parent.parent / "secrets.yaml"
# Arguments each command takes after its name
ARG_COUNT = {"status": 0, "set-time": 2, "set-number": 2, "press": 1}
TIME_RE = re.compile(r"([01]\d|2[0-3]):[0-5]\d")


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


def check_args(cmd: str, args: list[str], by_name: dict) -> str | None:
    """Returns an error message for a bad command line, or None if it's usable."""
    if cmd not in ARG_COUNT:
        return f"Unknown command: {cmd}. Use one of: {', '.join(ARG_COUNT)}"
    if len(args) != ARG_COUNT[cmd]:
        return __doc__
    if args and args[0] not in by_name:
        return f'No entity named "{args[0]}". Run "status" to list them.'
    if cmd == "set-time" and not TIME_RE.fullmatch(args[1]):
        return f"Time must be HH:MM, got {args[1]}"
    if cmd == "set-number":
        try:
            float(args[1])
        except ValueError:
            return f"Not a number: {args[1]}"
    return None


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
        error = check_args(cmd, args, by_name)
        if error:
            print(error)
            return 1
        if cmd == "set-time":
            hour, minute = (int(v) for v in args[1].split(":"))
            cli.time_command(by_name[args[0]].key, hour, minute, 0)
        elif cmd == "set-number":
            cli.number_command(by_name[args[0]].key, float(args[1]))
        elif cmd == "press":
            cli.button_command(by_name[args[0]].key)
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
