// IR Mate web app. Served by the device's ESPHome web_server (js_include), so it
// must stay dependency-free and work offline. Talks to the ESPHome REST API
// (POST /<domain>/<name>/<action>) and the /events Server-Sent Events stream.

// The AC is whichever climate entity the firmware exposes (named by ac_name in ir-mate.yaml).
const ENTITY = {
  slot: "select/signal_select",
  learn: "button/Learn",
  learnCancel: "button/Learn cancel",
  send: "button/Send",
  clearSlot: "button/Clear selected signal",
  learned: "text_sensor/Remote learned slots",
  learnStatus: "text_sensor/Remote learn status",
  sleep: "text_sensor/Sleep timer",
  sleepCancel: "button/Sleep timer cancel",
  clock: "text_sensor/Device clock",
  ip: "text_sensor/IP address",
  ssid: "text_sensor/WiFi network",
  rssi: "sensor/WiFi signal",
};
const remoteNameId = (i) => `text/Remote name ${i}`;

const SCHEDULE = [
  { title: "Turn on", label: "On", time: "time/AC auto-on time", temp: "number/AC auto-on temperature", enabled: "switch/AC auto-on enabled", help: "Starts cooling at this temperature." },
  { title: "Make it warmer", label: "Warmer", time: "time/AC night step time", temp: "number/AC night step temperature", enabled: "switch/AC night step enabled", help: "Raises the temperature if the AC is running." },
  { title: "Turn off", label: "Off", time: "time/AC auto-off time", enabled: "switch/AC auto-off enabled", help: "Switches the AC off." },
];

const MODES = [
  { id: "COOL", label: "Cool", name: "Cooling", color: "cool" },
  { id: "DRY", label: "Dry", name: "Drying", color: "dry" },
  { id: "FAN_ONLY", label: "Fan", name: "Fan only", color: "fan" },
  { id: "HEAT_COOL", label: "Auto", name: "Auto", color: "auto" },
  { id: "HEAT", label: "Heat", name: "Heating", color: "heat" },
];
// Display order and labels for the climate fan/swing modes a driver may report
const FAN_LABELS = { AUTO: "Auto", QUIET: "Quiet", LOW: "Low", MIDDLE: "Middle", MEDIUM: "Medium", HIGH: "High", FOCUS: "Focus", DIFFUSE: "Diffuse", ON: "On", OFF: "Off" };
const SWING_LABELS = { OFF: "Off", VERTICAL: "Up-down", HORIZONTAL: "Left-right", BOTH: "Both" };
const SLEEP_OPTIONS = [["1h", "1 hour"], ["2h", "2 hours"], ["3h", "3 hours"]];
const SLOT_COUNT = 10;
const NAME_MAX = 24;
// Used until the device reports its own temperature range
const FALLBACK_TEMP_MIN = 18;
const FALLBACK_TEMP_MAX = 30;
const TEMP_DEBOUNCE_MS = 700;
const LEARN_TIMEOUT_S = 30;
const RECONNECT_MS = 3000;
const STALE_MS = 30000;
const TOAST_MS = 2800;
const DELETE_CONFIRM_MS = 4000;
const LAST_MODE_KEY = "irm.lastMode";
const CLASSIC_JS = "https://oi.esphome.io/v3/www.js";
const ERR_OFFLINE = "Couldn't reach the IR Mate. Check that it's powered and on Wi-Fi.";

const ICON = {
  power: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><path d="M12 3v8"/><path d="M6.3 6.8a8 8 0 1 0 11.4 0"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 20h4L19 9l-4-4L4 16z"/><path d="M13.5 6.5l4 4"/></svg>',
};

// ---------- small helpers ----------

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "text") el.textContent = value;
    else if (key === "icon") el.innerHTML = ICON[value];
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

function storageGet(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function storageSet(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: preference is optional */ }
}

function fmtTime(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(value || "");
  if (!match) return "--:--";
  const hour = Number(match[1]);
  return `${((hour + 11) % 12) + 1}:${match[2]} ${hour < 12 ? "AM" : "PM"}`;
}

function fmtUptime(seconds) {
  if (!Number.isFinite(seconds)) return "--";
  const d = Math.floor(seconds / 86400);
  const hr = Math.floor((seconds % 86400) / 3600);
  const min = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${hr}h`;
  if (hr > 0) return `${hr}h ${min}m`;
  return `${min}m`;
}

function signalQuality(rssi) {
  if (!Number.isFinite(rssi)) return { bars: 0, label: "--" };
  if (rssi >= -55) return { bars: 4, label: "Excellent" };
  if (rssi >= -67) return { bars: 3, label: "Good" };
  if (rssi >= -75) return { bars: 2, label: "Fair" };
  return { bars: 1, label: "Weak" };
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// ---------- device state and commands ----------

const state = new Map();
const live = { status: "wait", uptime: null, lastSeen: 0 };
const val = (id) => state.get(id)?.value;

let acEntityId = null;
const acState = () => (acEntityId ? state.get(acEntityId) : undefined);

let queue = Promise.resolve();

// Commands run one at a time so multi-step actions (select slot, then send) never interleave.
function command(id, action, params = {}) {
  const slash = id.indexOf("/");
  const query = new URLSearchParams(params).toString();
  const url = `/${id.slice(0, slash)}/${encodeURIComponent(id.slice(slash + 1))}/${action}${query ? `?${query}` : ""}`;
  const run = queue.then(async () => {
    const res = await fetch(url, { method: "POST", credentials: "same-origin" });
    if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  });
  queue = run.catch(() => {});
  return run;
}

async function attempt(action, successMessage) {
  try {
    await action();
    if (successMessage) toast(successMessage);
    return true;
  } catch (err) {
    console.error(err);
    toast(ERR_OFFLINE, true);
    return false;
  }
}

let events = null;
let staleTimer = 0;

function connect() {
  if (events) events.close();
  events = new EventSource("/events");
  events.addEventListener("open", () => setLive("live"));
  events.addEventListener("state", (e) => {
    const data = JSON.parse(e.data);
    state.set(data.id, { ...state.get(data.id), ...data });
    if (!acEntityId && data.id.startsWith("climate/")) acEntityId = data.id;
    onStateChange(data.id);
    touch();
  });
  events.addEventListener("ping", (e) => {
    const data = JSON.parse(e.data);
    if (Number.isFinite(data.uptime)) live.uptime = data.uptime;
    touch();
  });
  // ESPHome asks for a 30 s retry; reconnect sooner so the page recovers quickly.
  events.addEventListener("error", () => {
    clearTimeout(staleTimer);
    setLive("down");
    events.close();
    setTimeout(connect, RECONNECT_MS);
  });
}

function touch() {
  live.lastSeen = Date.now();
  if (live.status !== "live") setLive("live");
  clearTimeout(staleTimer);
  staleTimer = setTimeout(() => { setLive("down"); connect(); }, STALE_MS);
  scheduleRender();
}

function setLive(status) {
  live.status = status;
  scheduleRender();
}

// ---------- UI shell ----------

const ui = {};

function buildShell() {
  ui.liveText = h("span");
  ui.bars = h("span", { class: "bars", "aria-hidden": "true" }, h("i"), h("i"), h("i"), h("i"));
  ui.live = h("div", { class: "live", role: "status" }, h("span", { class: "dot" }), ui.liveText, ui.bars);

  // Two columns on wide screens (the remote, then everything else); stacked on phones.
  ui.app = h("main", { class: "app" },
    h("header", { class: "top" }, ui.title = h("h1", { text: "Air conditioner" }), ui.live),
    h("div", { class: "cols" },
      h("div", { class: "col-remote" },
        buildHero(),
        section("Air", null, buildAirPanel())),
      h("div", { class: "col-rest" },
        section("Sleep timer", null, ui.sleepPanel = h("div", { class: "panel" })),
        section("Tonight", "Tap a time to change it",
          h("div", { class: "panel" }, ui.timeline = h("div", { class: "timeline" }), ui.timelineNote = h("p", { class: "timeline-note" }))),
        section("Other remotes", null, h("div", { class: "panel" }, ui.remotes = h("div"))),
        section("Device", null, buildDevicePanel()))),
  );
  ui.toast = h("div", { class: "toast", role: "status", "aria-live": "polite" });
  ui.sheet = h("dialog", { class: "sheet" });
  // Fires for Esc / back gesture; closeSheet() runs the callback itself first.
  ui.sheet.addEventListener("close", runSheetOnClose);
  // A click whose target is the dialog itself landed on the backdrop.
  ui.sheet.addEventListener("click", (e) => { if (e.target === ui.sheet) closeSheet(); });
  document.body.replaceChildren(ui.app, ui.toast, ui.sheet);
}

function section(title, aside, content) {
  return h("section", { class: "sec" },
    h("div", { class: "sec-head" }, h("h2", { text: title }), aside ? h("span", { class: "aside", text: aside }) : null),
    content);
}

function buildHero() {
  const C = 2 * Math.PI * 46;
  ui.ringLen = C * 0.75;
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("aria-hidden", "true");
  for (const cls of ["track", "arc"]) {
    const circle = document.createElementNS(ns, "circle");
    for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: 46, fill: "none", "stroke-width": 5, "stroke-linecap": "round", class: cls })) circle.setAttribute(k, v);
    circle.setAttribute("stroke-dasharray", `${ui.ringLen} ${C}`);
    svg.append(circle);
  }
  ui.arc = svg.lastChild;

  ui.temp = h("div", { class: "temp num" });
  ui.modeName = h("div", { class: "mode-name" });
  ui.minus = h("button", { class: "step", "aria-label": "Lower temperature", text: "−", onclick: () => changeTemp(-1) });
  ui.plus = h("button", { class: "step", "aria-label": "Raise temperature", text: "+", onclick: () => changeTemp(1) });
  ui.powerLabel = h("span");
  ui.power = h("button", { class: "power", onclick: togglePower }, h("span", { icon: "power" }), ui.powerLabel);
  ui.hero = h("section", { class: "hero" },
    h("div", { class: "dial" }, ui.minus, h("div", { class: "ring" }, svg, h("div", { class: "ring-inner" }, ui.temp, ui.modeName)), ui.plus),
    ui.power);
  return ui.hero;
}

function buildAirPanel() {
  ui.modeSeg = h("div", { class: "seg", role: "group", "aria-label": "Mode" });
  ui.fanSeg = h("div", { class: "seg", role: "group", "aria-label": "Fan speed" });
  ui.swingSeg = h("div", { class: "seg", role: "group", "aria-label": "Swing" });
  return h("div", { class: "panel" },
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Mode" }), ui.modeSeg),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Fan" }), ui.fanSeg),
    h("div", { class: "field" }, h("span", { class: "field-label", text: "Swing" }), ui.swingSeg));
}

function buildDevicePanel() {
  ui.facts = {};
  const rows = [["wifi", "Wi-Fi signal"], ["ssid", "Network"], ["ip", "IP address"], ["clock", "Device clock"], ["uptime", "Running for"]];
  const dl = h("dl", { class: "facts" }, rows.map(([key, label]) => [h("dt", { text: label }), ui.facts[key] = h("dd", { class: "num" })]));
  return h("div", {},
    h("div", { class: "panel" }, dl),
    h("div", { class: "links" }, h("a", { href: "?classic", text: "Classic view" }), h("a", { href: "/", text: "Reload" })));
}

// ---------- rendering ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => { renderQueued = false; render(); });
}

function render() {
  renderLive();
  renderHero();
  renderAir();
  renderSleep();
  renderTimeline();
  renderRemotes();
  renderDevice();
}

function renderLive() {
  ui.live.dataset.state = live.status;
  ui.liveText.textContent = { live: "Connected", down: "Reconnecting", wait: "Connecting" }[live.status];
  const { bars } = signalQuality(Number(val(ENTITY.rssi)));
  [...ui.bars.children].forEach((bar, i) => bar.classList.toggle("on", i < bars));
}

function currentMode() {
  return acState()?.mode;
}

function renderHero() {
  const ac = acState();
  const mode = ac?.mode;
  const isOff = !mode || mode === "OFF";
  const info = MODES.find((m) => m.id === mode);
  if (info && info.id !== lastMode()) storageSet(LAST_MODE_KEY, info.id);
  const color = info?.color || MODES.find((m) => m.id === lastMode())?.color || "cool";
  ui.app.style.setProperty("--mode", `var(--${color})`);
  ui.hero.classList.toggle("off", isOff);

  const temp = displayTemp();
  ui.temp.replaceChildren(Number.isFinite(temp) ? String(temp) : "--", h("sup", { text: "°C" }));
  ui.modeName.textContent = !ac ? "Connecting" : isOff ? "Off" : info?.name || mode;
  const [lo, hi] = tempLimits();
  const frac = Number.isFinite(temp) ? clamp((temp - lo) / Math.max(1, hi - lo), 0.04, 1) : 0;
  ui.arc.setAttribute("stroke-dashoffset", String(ui.ringLen * (1 - frac)));

  ui.minus.disabled = !ac || temp <= lo;
  ui.plus.disabled = !ac || temp >= hi;
  ui.power.disabled = !ac;
  ui.powerLabel.textContent = isOff ? "Turn on" : "Turn off";
  ui.power.setAttribute("aria-label", isOff ? "Turn the AC on" : "Turn the AC off");
  if (ac?.name && ui.title.textContent !== ac.name) {
    ui.title.textContent = ac.name;
    document.title = ac.name;
  }
}

function renderSegment(container, options, current, onPick) {
  if (container.childElementCount !== options.length) {
    container.replaceChildren(...options.map((o) => h("button", { type: "button", text: o.label, "data-value": o.value, onclick: () => onPick(o.value) })));
  }
  for (const btn of container.children) btn.setAttribute("aria-pressed", String(btn.dataset.value === current));
}

function renderAir() {
  const ac = acState();
  const modes = MODES.filter((m) => !ac?.modes || ac.modes.includes(m.id)).map((m) => ({ value: m.id, label: m.label }));
  renderSegment(ui.modeSeg, modes, ac?.mode, setMode);
  renderSegment(ui.fanSeg, modeOptions(ac?.fan_modes, FAN_LABELS), ac?.fan_mode, (v) => setClimate("fan_mode", v));
  renderSegment(ui.swingSeg, modeOptions(ac?.swing_modes, SWING_LABELS), ac?.swing_mode, (v) => setClimate("swing_mode", v));
  ui.fanSeg.closest(".field").hidden = !ac?.fan_modes?.length;
  ui.swingSeg.closest(".field").hidden = !ac?.swing_modes?.length;
}

function renderSleep() {
  const status = val(ENTITY.sleep);
  const active = Boolean(status) && status !== "Not set";
  const key = active ? `on:${status}` : "off";
  if (ui.sleepPanel.dataset.key === key) return;
  ui.sleepPanel.dataset.key = key;
  if (active) {
    const at = /(\d{1,2}:\d{2})/.exec(status);
    ui.sleepPanel.replaceChildren(h("div", { class: "sleep-status" },
      h("span", {}, "Turns the AC off at ", h("strong", { class: "num", text: at ? fmtTime(at[1]) : status })),
      h("button", { class: "chip ghost", type: "button", text: "Cancel", onclick: cancelSleep })));
  } else {
    ui.sleepPanel.replaceChildren(h("div", { class: "chips" },
      SLEEP_OPTIONS.map(([id, label]) => h("button", { class: "chip", type: "button", text: label, onclick: () => startSleep(id, label) }))));
  }
}

function renderTimeline() {
  const key = JSON.stringify(SCHEDULE.map((s) => [val(s.time), val(s.temp), val(s.enabled)]));
  if (ui.timeline.dataset.key !== key) {
    ui.timeline.dataset.key = key;
    renderTimelineNodes();
  }
  const clock = val(ENTITY.clock);
  ui.timelineNote.textContent = !clock ? "" : clock === "Not synced"
    ? "The device clock isn't synced yet. Schedules start once it's back online."
    : `Runs every day by the device clock, now ${fmtTime(clock)}.`;
}

function renderTimelineNodes() {
  ui.timeline.replaceChildren(...SCHEDULE.map((step, index) => {
    const enabled = val(step.enabled) !== false;
    const temp = step.temp ? Number(val(step.temp)) : null;
    const what = !enabled ? "Paused" : step.temp && Number.isFinite(temp) ? `${step.label}, ${temp}°` : step.label;
    return h("button", { class: `node${enabled ? "" : " paused"}`, type: "button", "aria-label": `${step.title} at ${fmtTime(val(step.time))}. ${what}`, onclick: () => openSchedule(index) },
      h("span", { class: "pin" }), h("span", { class: "t num", text: fmtTime(val(step.time)) }), h("span", { class: "what", text: what }));
  }));
}

function remoteSlots() {
  const learned = val(ENTITY.learned) || "";
  return Array.from({ length: SLOT_COUNT }, (_, i) => {
    const name = (val(remoteNameId(i)) || "").trim();
    return { index: i, name, label: name || `Button ${i + 1}`, learned: learned[i] === "1" };
  });
}

function renderRemotes() {
  const slots = remoteSlots();
  const used = slots.filter((s) => s.learned || s.name);
  const key = JSON.stringify(used) + (val(ENTITY.learned) === undefined ? "?" : "");
  if (ui.remotes.dataset.key === key) return;
  ui.remotes.dataset.key = key;
  const tiles = used.map((s) => h("div", { class: "remote" },
    h("button", { class: "send", type: "button", onclick: () => (s.learned ? sendRemote(s) : startLearn(s)) },
      s.label, s.learned ? null : h("small", { text: "Not taught yet. Tap to teach." })),
    h("button", { class: "edit", type: "button", icon: "edit", "aria-label": `Edit ${s.label}`, onclick: () => openManage(s.index) })));
  const free = slots.find((s) => !s.learned && !s.name);
  if (free) tiles.push(h("button", { class: "add", type: "button", text: "Add a button", onclick: () => openAdd(free.index) }));
  const intro = used.length ? [] : [h("p", { class: "empty", text: "Teach the IR Mate buttons from your TV, fan or any other remote, then press them here." })];
  ui.remotes.replaceChildren(...intro, h("div", { class: "remotes" }, tiles));
}

function renderDevice() {
  const rssi = Number(val(ENTITY.rssi));
  const quality = signalQuality(rssi);
  ui.facts.wifi.textContent = Number.isFinite(rssi) ? `${quality.label} (${Math.round(rssi)} dBm)` : "--";
  ui.facts.ssid.textContent = val(ENTITY.ssid) || "--";
  ui.facts.ip.textContent = val(ENTITY.ip) || location.hostname;
  const clock = val(ENTITY.clock);
  ui.facts.clock.textContent = !clock ? "--" : clock === "Not synced" ? "Not synced" : fmtTime(clock);
  ui.facts.uptime.textContent = fmtUptime(live.uptime);
}

function onStateChange(id) {
  if (id === acEntityId && pendingTemp !== null && Number(state.get(id).target_temperature) === pendingTemp) pendingTemp = null;
  if (id === ENTITY.learnStatus) onLearnStatus(val(id));
}

// ---------- AC actions ----------

let pendingTemp = null;
let tempTimer = 0;

function lastMode() {
  const saved = storageGet(LAST_MODE_KEY);
  return MODES.some((m) => m.id === saved) ? saved : "COOL";
}

function tempLimits() {
  const ac = acState();
  const lo = Number(ac?.min_temp);
  const hi = Number(ac?.max_temp);
  return [Number.isFinite(lo) ? lo : FALLBACK_TEMP_MIN, Number.isFinite(hi) ? hi : FALLBACK_TEMP_MAX];
}

function displayTemp() {
  if (pendingTemp !== null) return pendingTemp;
  return Number(acState()?.target_temperature);
}

// Taps are batched so several presses send one IR command, like a real remote.
function changeTemp(delta) {
  const current = displayTemp();
  if (!Number.isFinite(current)) return;
  const [lo, hi] = tempLimits();
  const next = clamp(Math.round(current) + delta, lo, hi);
  if (next === current) return;
  pendingTemp = next;
  scheduleRender();
  clearTimeout(tempTimer);
  tempTimer = setTimeout(async () => {
    const ok = await attempt(() => command(acEntityId, "set", { target_temperature: next }));
    if (!ok && pendingTemp === next) { pendingTemp = null; scheduleRender(); }
  }, TEMP_DEBOUNCE_MS);
}

function togglePower() {
  const isOff = (currentMode() || "OFF") === "OFF";
  attempt(() => command(acEntityId, "set", { mode: isOff ? lastMode() : "OFF" }));
}

function setMode(mode) {
  if (mode === currentMode()) return;
  attempt(() => command(acEntityId, "set", { mode }));
}

function setClimate(param, value) {
  if (value === acState()?.[param]) return;
  attempt(() => command(acEntityId, "set", { [param]: value }));
}

// Orders a driver's reported modes by the label table and drops unknown ones
function modeOptions(reported, labels) {
  const available = new Set(reported || []);
  return Object.keys(labels).filter((m) => available.has(m)).map((m) => ({ value: m, label: labels[m] }));
}

function startSleep(id, label) {
  attempt(() => command(`button/Sleep timer ${id}`, "press"), `Sleep timer set for ${label}`);
}

function cancelSleep() {
  attempt(() => command(ENTITY.sleepCancel, "press"), "Sleep timer cancelled");
}

// ---------- sheets ----------

let sheetOnClose = null;

function runSheetOnClose() {
  const fn = sheetOnClose;
  sheetOnClose = null;
  if (fn) fn();
}

// Reuses an already-open sheet instead of closing it: the dialog "close" event
// fires asynchronously and would otherwise hit the next sheet's callback.
function openSheet(content, onClose = null) {
  sheetOnClose = onClose;
  ui.sheet.replaceChildren(h("form", { onsubmit: (e) => e.preventDefault() }, content));
  if (!ui.sheet.open) ui.sheet.showModal();
  ui.sheet.querySelector("input[type=text], input[type=time]")?.focus();
}

function closeSheet() {
  runSheetOnClose();
  if (ui.sheet.open) ui.sheet.close();
}

function miniStepper(value, lo, hi) {
  let current = value;
  const out = h("output", { class: "num", text: `${current}°` });
  const set = (delta) => { current = clamp(current + delta, lo, hi); out.textContent = `${current}°`; };
  const el = h("div", { class: "mini" },
    h("button", { type: "button", text: "−", "aria-label": "Lower", onclick: () => set(-1) }), out,
    h("button", { type: "button", text: "+", "aria-label": "Raise", onclick: () => set(1) }));
  return { el, get: () => current };
}

function toggleInput(checked, label) {
  const input = h("input", { type: "checkbox", "aria-label": label });
  input.checked = checked;
  return { el: h("label", { class: "toggle" }, input, h("span")), input };
}

function openSchedule(index) {
  const step = SCHEDULE[index];
  const time = h("input", { type: "time", value: (val(step.time) || "00:00").slice(0, 5), required: true });
  const limits = state.get(step.temp);
  const temp = step.temp ? miniStepper(Number(val(step.temp)) || FALLBACK_TEMP_MIN, Number(limits?.min_value) || FALLBACK_TEMP_MIN, Number(limits?.max_value) || FALLBACK_TEMP_MAX) : null;
  const enabled = toggleInput(val(step.enabled) !== false, "Run every day");
  const save = async () => {
    if (!time.value) return;
    closeSheet();
    await attempt(async () => {
      if (`${time.value}:00` !== val(step.time)) await command(step.time, "set", { value: `${time.value}:00` });
      if (temp && temp.get() !== Number(val(step.temp))) await command(step.temp, "set", { value: temp.get() });
      if (enabled.input.checked !== (val(step.enabled) !== false)) await command(step.enabled, enabled.input.checked ? "turn_on" : "turn_off");
    }, "Schedule saved");
  };
  openSheet([
    h("h3", { text: step.title }), h("p", { text: step.help }),
    h("div", { class: "row" }, h("span", { text: "Time" }), time),
    temp ? h("div", { class: "row" }, h("span", { text: "Temperature" }), temp.el) : null,
    h("div", { class: "row" }, h("span", { text: "Run every day" }), enabled.el),
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: "Save", onclick: save }),
      h("button", { class: "btn plain", type: "button", text: "Cancel", onclick: closeSheet })),
  ]);
}

function nameField(value) {
  const input = h("input", { type: "text", maxlength: NAME_MAX, placeholder: "TV power", autocomplete: "off", value });
  const error = h("p", { class: "field-error", role: "alert" });
  const read = () => {
    const name = input.value.trim();
    error.textContent = name ? "" : "Give the button a name.";
    return name;
  };
  return { el: [input, error], read };
}

function openAdd(index) {
  const field = nameField("");
  const start = async () => {
    const name = field.read();
    if (!name) return;
    if (await attempt(() => command(remoteNameId(index), "set", { value: name }))) startLearn({ index, label: name });
  };
  openSheet([
    h("h3", { text: "Add a button" }), h("p", { text: "Name it, then press the button on your remote to teach the IR Mate." }),
    field.el,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: "Start teaching", onclick: start }),
      h("button", { class: "btn plain", type: "button", text: "Cancel", onclick: closeSheet })),
  ]);
}

function openManage(index) {
  const slot = remoteSlots()[index];
  const field = nameField(slot.name);
  let deleteArmed = false;
  const del = h("button", { class: "btn danger", type: "button", text: "Delete button" });
  del.addEventListener("click", async () => {
    if (!deleteArmed) {
      deleteArmed = true;
      del.textContent = "Tap again to delete";
      setTimeout(() => { deleteArmed = false; del.textContent = "Delete button"; }, DELETE_CONFIRM_MS);
      return;
    }
    closeSheet();
    await attempt(async () => {
      await command(ENTITY.slot, "set", { option: `Signal${index}` });
      await command(ENTITY.clearSlot, "press");
      await command(remoteNameId(index), "set", { value: "" });
    }, `Deleted ${slot.label}`);
  });
  const rename = async () => {
    const name = field.read();
    if (!name) return;
    closeSheet();
    if (name !== slot.name) await attempt(() => command(remoteNameId(index), "set", { value: name }), "Name saved");
  };
  openSheet([
    h("h3", { text: slot.label }), h("p", { text: slot.learned ? "Rename it, teach it again, or delete it." : "This button hasn't been taught yet." }),
    field.el,
    h("div", { class: "actions" },
      h("button", { class: "btn primary", type: "button", text: "Save name", onclick: rename }),
      h("button", { class: "btn", type: "button", text: slot.learned ? "Teach again" : "Teach now", onclick: () => startLearn({ index, label: field.read() || slot.label }) }),
      del,
      h("button", { class: "btn plain", type: "button", text: "Cancel", onclick: closeSheet })),
  ]);
}

async function sendRemote(slot) {
  await attempt(async () => {
    await command(ENTITY.slot, "set", { option: `Signal${slot.index}` });
    await command(ENTITY.send, "press");
  }, `Sent ${slot.label}`);
}

// ---------- teaching (IR learning) ----------

let learning = null;

function startLearn(slot) {
  const view = {
    box: h("div", { class: "listen" }),
    title: h("h3"),
    text: h("p"),
    count: h("p", { class: "num muted" }),
    actions: h("div", { class: "actions" }),
  };
  view.box.append(h("div", { class: "pulse", "aria-hidden": "true" }), view.title, view.text, view.count);
  if (learning) clearInterval(learning.timer);
  learning = { slot, view, deadline: Date.now() + LEARN_TIMEOUT_S * 1000, timer: 0, armed: false, finished: false };
  showListening();
  openSheet([view.box, view.actions], () => stopLearn(true));
  beginLearn(learning);
}

async function beginLearn(session) {
  const ok = await attempt(async () => {
    await command(ENTITY.slot, "set", { option: `Signal${session.slot.index}` });
    await command(ENTITY.learn, "press");
  });
  if (session !== learning) return;
  if (!ok) { stopLearn(false); closeSheet(); return; }
  session.armed = true;
  session.timer = setInterval(() => tickLearn(session), 500);
  tickLearn(session);
}

function tickLearn(session) {
  const left = Math.max(0, Math.ceil((session.deadline - Date.now()) / 1000));
  session.view.count.textContent = `${left} s left`;
  if (left === 0) finishLearn(session, false);
}

function showListening() {
  const { view } = learning;
  view.box.className = "listen";
  view.title.textContent = "Press the button on your remote";
  view.text.textContent = "Point the remote at the IR Mate from close up and press the button once.";
  view.count.textContent = `${LEARN_TIMEOUT_S} s left`;
  view.actions.replaceChildren(h("button", { class: "btn plain", type: "button", text: "Cancel", onclick: closeSheet }));
}

function onLearnStatus(status) {
  const session = learning;
  if (!session || !session.armed || session.finished) return;
  if (status === "saved") finishLearn(session, true);
  else if (status === "timeout") finishLearn(session, false);
}

function finishLearn(session, success) {
  if (session.finished) return;
  session.finished = true;
  clearInterval(session.timer);
  const { view, slot } = session;
  view.count.textContent = "";
  if (success) {
    view.box.className = "listen done";
    view.title.textContent = `Saved ${slot.label}`;
    view.text.textContent = "Tap the button any time to use it.";
    view.actions.replaceChildren(h("button", { class: "btn primary", type: "button", text: "Done", onclick: closeSheet }));
    return;
  }
  command(ENTITY.learnCancel, "press").catch((err) => console.error(err));
  view.box.className = "listen fail";
  view.title.textContent = "No signal received";
  view.text.textContent = "Hold the remote closer to the IR Mate, then try again.";
  view.actions.replaceChildren(
    h("button", { class: "btn primary", type: "button", text: "Try again", onclick: () => startLearn(slot) }),
    h("button", { class: "btn plain", type: "button", text: "Close", onclick: closeSheet }));
}

function stopLearn(userClosed) {
  const session = learning;
  if (!session) return;
  learning = null;
  clearInterval(session.timer);
  if (userClosed && !session.finished) command(ENTITY.learnCancel, "press").catch((err) => console.error(err));
}

// ---------- toast ----------

let toastTimer = 0;
function toast(message, isError = false) {
  ui.toast.textContent = message;
  ui.toast.classList.toggle("error", isError);
  ui.toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => ui.toast.classList.remove("show"), TOAST_MS);
}

// ---------- boot ----------

function addHeadTags() {
  const tags = [
    ["meta", { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" }],
    ["meta", { name: "theme-color", content: "#0d1322", media: "(prefers-color-scheme: dark)" }],
    ["meta", { name: "theme-color", content: "#eef2f8", media: "(prefers-color-scheme: light)" }],
  ];
  for (const [tag, attrs] of tags) document.head.append(h(tag, attrs));
}

function bootClassic() {
  document.title = "IR Mate (classic)";
  const script = h("script", { src: CLASSIC_JS });
  script.addEventListener("error", () => {
    document.body.append(h("p", { class: "classic-msg", text: "The classic view needs an internet connection. Use the app view instead." }));
  });
  document.body.append(script, h("a", { class: "back", href: "/", text: "Back to app" }));
}

function bootApp() {
  document.title = "Air conditioner";
  document.body.classList.add("irm");
  buildShell();
  render();
  connect();
}

addHeadTags();
if (new URLSearchParams(location.search).has("classic")) bootClassic();
else bootApp();
