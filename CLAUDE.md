# XIAO IR Mate AC Scheduler: Project Rules

ESPHome firmware for a Seeed XIAO Smart IR Mate (ESP32-C3) that drives an IR air conditioner with
an on-device schedule and an embedded web app. No Home Assistant. README.md covers features,
installation and recovery. If `NOTES.local.md` exists, it holds this installation's IP, network and
history (gitignored, never commit its contents).

## Commands

```bash
esphome config ir-mate.yaml                                # validate (always before flashing)
esphome run ir-mate.yaml --device <device-ip> --no-logs    # build + OTA flash
esphome logs ir-mate.yaml --device <device-ip>             # live logs (logger level INFO)
node --check web/app.js                                    # web app syntax
IRMATE_HOST=<device-ip> uv run -q --python 3.12 --with aioesphomeapi --with pyyaml python -I scripts/device.py status
```

Install ESPHome on a uv-managed Python (`uv tool install --python-preference only-managed --python 3.12 esphome`):
system Pythons without `venv` break the ESP-IDF toolchain setup.

## Layout

- `ir-mate.yaml`: user settings only (substitutions) plus the package list.
- `packages/seeed_base.yaml`: derived from Seeed's stock firmware (GPL-3.0). Keep the header listing
  changes from upstream up to date when editing it.
- Feature packages (`ac`, `schedule`, `remotes`, `network`, `web`) each own their entities. Packages
  merge lists (`button:`, `script:`, `text_sensor:` ...), so cross-package `id()` references are fine,
  but `esphome: on_boot` lives only in `seeed_base.yaml`.

## Config Rules

- Credentials only via `!secret`; never inline them, never print them. `secrets.example.yaml` must
  keep validating in CI (non-zero dummy API key).
- AC-specific values are substitutions (`ac_platform`, `ac_name`, temperature range, schedule
  defaults, `timezone`). Don't hardcode a brand or name in packages or the web app.
- Runtime-tunable values are template `datetime` / `number` / `switch` entities with restore, so
  they're editable in the web app and survive reboots.
- Never add an action that sends IR on boot or on restore (e.g. `on_value` on a restored select).
- `api: reboot_timeout: 0s` is required: with no API client the default reboots every 15 minutes.
- Entity names are the web app's API. Renaming one breaks the app; update `web/app.js` in the same change.
- No YAML merge keys (`<<:`) in packages: ESPHome warns about them.

## Web App (web/app.js, web/app.css)

- Embedded via `web_server` `js_include` / `css_include` with `js_url: ""`: offline, single file each.
  `?classic` loads the stock UI from oi.esphome.io on demand.
- Vanilla JS, no dependencies, no external fonts or CDNs.
- The AC is the first `climate/` entity in the event stream; fan, swing, mode lists and the temperature
  range come from that entity, so the app works for any `ac_platform`.
- REST: `POST /<domain>/<url-encoded name>/<action>?<params>` (curl needs `-d ""`). Live state: SSE
  `GET /events` with `state` and `ping` events.
- All commands go through the serial `command()` queue so multi-step actions never interleave.
- Render user/device data with `textContent` only; `innerHTML` is for the constant SVG icons.
- Layout: single column on phones, two columns from 900 px. Verify both widths and both themes
  in a browser after UI changes; the console must stay clean.

## Known Pitfalls

- IR needs line of sight: "nothing happened" is usually aim, not firmware.
- The ESP32-C3 receiver truncates long AC frames (~384 pulses), so learning is for short remotes only.
- Flashing reboots the device; the web page is unreachable for 10-20 s.
- Phone tabs left open hold event-stream connections; the server closes stuck ones after 20 s.

## Workflow

- Validate, flash, then confirm with `scripts/device.py status` that entities and restored values are intact.
- Ask the user before flashing: the device controls a real appliance.
- Update README.md when entities, settings or defaults change.
