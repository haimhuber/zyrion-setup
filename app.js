// ======================================================
// ZYRION Setup - configures sensors over Web Bluetooth
// UUIDs must match include/BleSetupManager.h
// ======================================================

const SERVICE_UUID = "5a7e0001-8f2b-4c3d-9a1e-2b7c6d5e4f30";
const INFO_UUID    = "5a7e0002-8f2b-4c3d-9a1e-2b7c6d5e4f30";
const SCAN_UUID    = "5a7e0003-8f2b-4c3d-9a1e-2b7c6d5e4f30";
const CONFIG_UUID  = "5a7e0004-8f2b-4c3d-9a1e-2b7c6d5e4f30";
const STATUS_UUID  = "5a7e0005-8f2b-4c3d-9a1e-2b7c6d5e4f30";

const CHUNK_SIZE = 180;
// Must match ConfigManager::PUBLISH_INTERVAL_* in the firmware
const DEFAULT_PUBLISH_INTERVAL = 30;
const MIN_PUBLISH_INTERVAL = 5;
const MAX_PUBLISH_INTERVAL = 300;
const MANUAL_SSID = "__manual__";

// Sensor profiles. The firmware reports which ones its image carries
// (info.profiles); these are the names a person reads. A key the firmware
// offers and this list does not know is still shown, by its key, rather
// than being hidden - the firmware is the authority on what it supports.
const PROFILE_LABELS = {
  sht31: "SHT31 — temperature and humidity",
  scd41: "M5Stack U104 / SCD41 — CO₂, temperature and humidity",
  bh1750: "BH1750 — light level",
  dht: "DHT11 / DHT22 — temperature and humidity",
  auto: "Automatic — SHT31 or DHT (older sensors)"
};

// Used only if a sensor does not report its list
const FALLBACK_PROFILES = ["sht31", "scd41", "bh1750", "dht", "auto"];

// Must match data-app-version on <body> in index.html, and the ?v= on the
// script tag that loads this file.
//
// Why this exists: a page served fresh alongside a cached older app.js
// renders the Sensor card with nothing to put in it, and the person sees an
// empty dropdown with no explanation. The versioned script URL stops that
// happening; this check catches it if it happens anyway.
const APP_VERSION = "10";

// Sensor firmware older than this has no probe command, so Check cannot work
const MIN_FIRMWARE_FOR_PROBE = "1.4.0";

// An SCD41 in low-power mode cannot produce its first sample for 30 s, and
// the probe waits for a real one rather than reporting a guess
const PROBE_TIMEOUT_MS = 75000;

// How often to read the status characteristic while waiting, in case a
// notification was lost
const STATUS_POLL_MS = 1500;

// Must match ConfigManager::MEASURE_INTERVAL_* in the firmware
const MIN_MEASURE_SECONDS = 1;
const MAX_MEASURE_SECONDS = 300;

const META_FIELDS = [
  "site", "building", "floor", "room", "department",
  "zone", "panel", "equipment", "description"
];
const REMEMBER_KEY = "zyrion-setup-last";

const $ = (id) => document.getElementById(id);

let device = null;
let chars = {};
let info = {};
let saving = false;
let connectError = false;
let lastStep = "";
let statusWaiters = [];

// Highest status counter seen from the sensor. Firmware 1.4.1 and newer
// stamps every status with one.
let lastStatusSeq = 0;

// Stamped on every command the app sends; firmware 1.4.1 and newer echoes it
// on every status, which is how an answer is matched to its request.
let commandToken = 0;

// The profile whose check passed on this sensor, and what it reported
let verifiedProfile = "";
let verifiedDetail = "";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// Web Bluetooth allows one GATT operation at a time
let gattQueue = Promise.resolve();
function gatt(operation) {
  const run = gattQueue.then(operation);
  gattQueue = run.catch(() => {});
  return run;
}

// ------------------------------------------------------
// UI helpers
// ------------------------------------------------------

function showStatus(kind, text, busy = false) {
  const el = $("status");
  el.className = `status show ${kind}`;
  el.innerHTML = "";
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    el.appendChild(spinner);
  }
  el.appendChild(document.createTextNode(text));
}

let logStart = Date.now();

function log(text) {
  const seconds = ((Date.now() - logStart) / 1000).toFixed(1);
  $("debugLog").textContent += `${seconds}s  ${text}\n`;
}

// Each attempt starts with an empty log. A line left over from an
// earlier attempt is indistinguishable from a current one, and a stale
// "selected <other sensor>" is exactly the sort of thing that sends
// someone chasing the wrong unit.
function startLog(header) {
  logStart = Date.now();
  $("debugLog").textContent = "";
  log(`${new Date().toLocaleTimeString()} — ${header}`);
}

function hideStatus() {
  $("status").className = "status";
}

function showStep(step) {
  for (const id of ["stepConnect", "stepConfig", "stepResult"]) {
    $(id).classList.toggle("hidden", id !== step);
  }
}

function setBusy(busy) {
  for (const el of $("stepConfig").querySelectorAll("input, select, button")) {
    el.disabled = busy;
  }
}

function loadRemembered() {
  try {
    return JSON.parse(localStorage.getItem(REMEMBER_KEY)) || {};
  } catch {
    return {};
  }
}

function remember(values) {
  try {
    localStorage.setItem(REMEMBER_KEY, JSON.stringify(values));
  } catch {
    // Storage unavailable - not critical
  }
}

// ------------------------------------------------------
// Bluetooth
// ------------------------------------------------------

// A rejection here can be a DOMException (Chrome), a plain object or a
// string (Bluefy on iOS), or nothing at all. Never render "undefined".
function describeError(error) {
  if (error === null || error === undefined) return "no error detail";
  if (typeof error === "string") return error;
  const name = typeof error.name === "string" ? error.name : "";
  const message =
    (typeof error.message === "string" && error.message) ||
    (typeof error.errorMessage === "string" && error.errorMessage) ||
    (typeof error.description === "string" && error.description) ||
    "";
  const text = [name, message].filter(Boolean).join(": ");
  if (text) return text;
  try {
    const json = JSON.stringify(error);
    if (json && json !== "{}") return json;
  } catch {
    // not serialisable
  }
  return String(error) === "[object Object]" ? "no error detail" : String(error);
}

// What the technician should DO. The raw detail stays in the log.
function failureAdvice(step, detail) {
  const text = `${step} ${detail}`.toLowerCase();

  const looksLikePairing =
    /encrypt|authent|pair|bond|security|insufficient|0x05|0x0f|133/.test(text);

  if (looksLikePairing) {
    return (
      "Pairing was rejected. If this sensor was reset, your phone still holds the old pairing: " +
      "open Bluetooth settings, choose Forget This Device for it, then connect again.\n" +
      "הצימוד נדחה. אם החיישן אופס, בטלפון עדיין שמור צימוד ישן: " +
      "פתח הגדרות Bluetooth, בחר Forget This Device עבורו, ונסה להתחבר שוב."
    );
  }

  if (step === "connect") {
    return (
      "Could not connect to the sensor. Move closer and try again. If it still fails, the phone may hold " +
      "an old pairing after a sensor reset: Bluetooth settings, Forget This Device, then connect again.\n" +
      "לא ניתן להתחבר לחיישן. התקרב אליו ונסה שוב. אם זה נמשך, ייתכן שבטלפון שמור צימוד ישן אחרי איפוס החיישן: " +
      "הגדרות Bluetooth, Forget This Device, ואז להתחבר מחדש."
    );
  }

  if (step === "read info") {
    return (
      "Connected, but the sensor refused to share its details. This is usually a wrong PIN or an old pairing: " +
      "Bluetooth settings, Forget This Device, then connect again and enter the PIN from the label.\n" +
      "יש חיבור, אך החיישן לא מוסר את הפרטים שלו. בדרך כלל זה PIN שגוי או צימוד ישן: " +
      "הגדרות Bluetooth, Forget This Device, ואז להתחבר שוב ולהקליד את ה-PIN מהמדבקה."
    );
  }

  return (
    "The sensor stopped responding. Keep the phone close, then connect again.\n" +
    "החיישן הפסיק להגיב. השאר את הטלפון קרוב אליו ונסה להתחבר שוב."
  );
}

async function readJson(characteristic) {
  const value = await gatt(() => characteristic.readValue());
  return JSON.parse(decoder.decode(value));
}

// Waits for the sensor to reach one of these states.
//
// afterSeq is the status counter as it stood when the command was sent. A
// status with a counter at or below it is an answer to something earlier -
// typically a read that was already in flight when the command went out,
// which comes back holding the previous result. Accepting one of those is
// how a fresh check ends up reporting the previous check's failure.
//
// It also polls. A notification is not acknowledged by the protocol, so one
// can simply be lost; without polling that costs the entire timeout.
function waitForStatus(states, timeoutMs, { token = 0, afterSeq = -1 } = {}) {
  return new Promise((resolve, reject) => {
    const waiter = { states, token, afterSeq, resolve: null };

    const finish = (status) => {
      clearInterval(poller);
      clearTimeout(timer);
      statusWaiters = statusWaiters.filter((w) => w !== waiter);
      resolve(status);
    };

    waiter.resolve = finish;

    statusWaiters.push(waiter);

    const poller = setInterval(() => {
      // Harmless if nothing changed: the read goes through the same queue
      // as everything else and resolves any waiter it satisfies
      onStatusChanged().catch(() => {});
    }, STATUS_POLL_MS);

    const timer = setTimeout(() => {
      clearInterval(poller);
      statusWaiters = statusWaiters.filter((w) => w !== waiter);
      reject(new Error("The sensor did not respond"));
    }, timeoutMs);
  });
}

async function onStatusChanged() {
  // Re-read so long values are never truncated by the notification size
  let status;
  try {
    status = await readJson(chars.status);
  } catch (error) {
    log(`status read ERROR: ${describeError(error)}`);
    return;
  }
  log(`status: ${JSON.stringify(status)}`);

  if (typeof status.seq === "number") {
    lastStatusSeq = Math.max(lastStatusSeq, status.seq);
  }

  // Progress from a command that is no longer the current one must not
  // repaint the screen - that is how a finished check ends up looking as if
  // it were still running.
  const current =
    typeof status.token !== "number" ||
    status.token === 0 ||
    status.token === commandToken;

  if (!current) {
    return;
  }

  if (status.state === "connecting") {
    showStatus("info", status.message || "Connecting to Wi-Fi...", true);
  } else if (status.state === "testing_broker") {
    showStatus("info", `Wi-Fi connected (${status.ip}). Checking broker...`, true);
  } else if (status.state === "scanning") {
    showStatus("info", "Scanning Wi-Fi networks...", true);
  } else if (status.state === "probing") {
    // The sensor reports each step of the check as it happens, so a slow
    // sensor does not look like a frozen screen
    showProbe("info", status.message || "Checking the sensor...", true);
  }

  for (const waiter of [...statusWaiters]) {
    if (!waiter.states.includes(status.state)) {
      continue;
    }

    // An answer to an earlier command is not an answer to this one. From
    // firmware 1.4.1 the sensor echoes the number the app put on the command,
    // which settles it whenever the answer happens to arrive.
    if (typeof status.token === "number" && waiter.token > 0) {
      if (status.token !== waiter.token) {
        log(
          `status ignored: token ${status.token} answers an earlier command, ` +
          `waiting for ${waiter.token}`
        );
        continue;
      }
    } else if (
      // Firmware without tokens: fall back to the counter, which closes the
      // common case even if it cannot close all of them
      typeof status.seq === "number" &&
      waiter.afterSeq >= 0 &&
      status.seq <= waiter.afterSeq
    ) {
      log(`status ignored: seq ${status.seq} is not newer than ${waiter.afterSeq}`);
      continue;
    }

    waiter.resolve(status);
  }
}

async function connect() {
  if (!navigator.bluetooth) {
    $("unsupported").classList.remove("hidden");
    return;
  }

  // Drop the previous device before choosing a new one, so a stale
  // object cannot report disconnects against the sensor in hand
  if (device) {
    device.removeEventListener("gattserverdisconnected", onDisconnected);
    device = null;
  }

  let chosen;
  try {
    chosen = await navigator.bluetooth.requestDevice({
      filters: [{ services: [SERVICE_UUID] }]
    });
  } catch {
    return; // user cancelled the chooser
  }

  device = chosen;
  device.addEventListener("gattserverdisconnected", onDisconnected);

  startLog(`chooser returned: ${device.name || "(no name)"} [${device.id || "no id"}]`);

  let step = "connect";
  connectError = false;
  lastStep = step;

  const enter = (name) => {
    step = name;
    lastStep = name;
    log(`step: ${name}`);
  };

  try {
    showStatus("info", `Connecting to ${device.name || "sensor"}...`, true);

    enter("connect");
    const server = await device.gatt.connect();

    enter("service");
    const service = await server.getPrimaryService(SERVICE_UUID);

    enter("characteristics");
    chars.info = await service.getCharacteristic(INFO_UUID);
    chars.scan = await service.getCharacteristic(SCAN_UUID);
    chars.config = await service.getCharacteristic(CONFIG_UUID);
    chars.status = await service.getCharacteristic(STATUS_UUID);

    // First secured read triggers the PIN pairing dialog
    enter("read info");
    showStatus("info", "If asked, enter the 6-digit PIN from the sensor label", true);
    const raw = await gatt(() => chars.info.readValue());
    const text = decoder.decode(raw);
    log(`info (${raw.byteLength} bytes): ${text}`);
    info = JSON.parse(text);

    enter("notifications");
    chars.status.addEventListener("characteristicvaluechanged", onStatusChanged);
    await gatt(() => chars.status.startNotifications());

    enter("form");
    fillForm();
    showStep("stepConfig");
    $("headerDevice").textContent = info.id;
    hideStatus();

    await scan();
  } catch (error) {
    // Keep this message: the disconnect below must not replace it
    connectError = true;
    const detail = describeError(error);
    log(`ERROR at ${step}: ${detail}`);
    $("debugDetails").open = true;
    showStatus("err", failureAdvice(step, detail));
    disconnect();
  }
}

// Bluefy (iOS) may lack writeValueWithResponse
function writeChar(characteristic, data) {
  return characteristic.writeValueWithResponse
    ? characteristic.writeValueWithResponse(data)
    : characteristic.writeValue(data);
}

function disconnect() {
  if (device && device.gatt.connected) {
    device.gatt.disconnect();
  }
}

function onDisconnected() {
  log(`disconnected (last step: ${lastStep})`);
  $("debugDetails").open = true;
  if (saving) {
    return; // expected: sensor restarts after saving
  }
  if (connectError) {
    showStep("stepConnect");
    return; // keep the error message visible
  }
  if (!$("stepResult").classList.contains("hidden")) {
    return;
  }
  showStep("stepConnect");
  $("headerDevice").textContent = "";
  showStatus("warn", "Sensor disconnected. Connect again to continue.");
}

// ------------------------------------------------------
// Wi-Fi scan
// ------------------------------------------------------

async function scan() {
  const select = $("ssidSelect");
  const current = selectedSsid() || info.ssid || loadRemembered().ssid || "";

  $("btnScan").disabled = true;
  showStatus("info", "Scanning Wi-Fi networks...", true);

  try {
    const done = waitForStatus(["scan_done"], 20000);
    log("scan: write request");
    await gatt(() => writeChar(chars.scan, Uint8Array.of(1)));
    log("scan: waiting for result");
    await done;

    const networks = await readJson(chars.scan);
    log(`scan: ${networks.length} networks`);

    select.innerHTML = "";

    for (const [ssid, rssi, secured] of networks) {
      const option = document.createElement("option");
      option.value = ssid;
      option.textContent = `${ssid}  ${signalBars(rssi)}${secured ? "" : "  (open)"}`;
      select.appendChild(option);
    }

    const manual = document.createElement("option");
    manual.value = MANUAL_SSID;
    manual.textContent = "Other network...";
    select.appendChild(manual);

    if (current && networks.some(([ssid]) => ssid === current)) {
      select.value = current;
    } else if (current) {
      select.value = MANUAL_SSID;
      $("ssidManual").value = current;
    }

    onSsidChanged();
    hideStatus();
  } catch (error) {
    log(`scan ERROR: ${describeError(error)}`);
    $("debugDetails").open = true;
    showStatus("err", `Wi-Fi scan failed. Keep the phone close to the sensor and press Scan again.
סריקת רשתות ה-Wi-Fi נכשלה. השאר את הטלפון קרוב לחיישן ולחץ Scan שוב.`);
  } finally {
    $("btnScan").disabled = false;
  }
}

function signalBars(rssi) {
  if (rssi >= -55) return "▂▄▆█";
  if (rssi >= -67) return "▂▄▆";
  if (rssi >= -78) return "▂▄";
  return "▂";
}

function selectedSsid() {
  const value = $("ssidSelect").value;
  return value === MANUAL_SSID ? $("ssidManual").value.trim() : value;
}

function onSsidChanged() {
  const manual = $("ssidSelect").value === MANUAL_SSID;
  $("ssidManualField").classList.toggle("hidden", !manual);

  // Saved password is kept when the network does not change
  const keep = info.ssid && selectedSsid() === info.ssid;
  $("password").placeholder = keep ? "Leave empty to keep saved password" : "";
}

// ------------------------------------------------------
// Sensor selection and check
// ------------------------------------------------------

function showProbe(kind, text, busy = false) {
  const el = $("probeResult");
  el.className = `status show ${kind}`;
  el.innerHTML = "";
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    el.appendChild(spinner);
  }
  el.appendChild(document.createTextNode(text));
}

// "1.4.0" vs "1.3.0" - numeric, part by part, missing parts count as 0
function firmwareAtLeast(version, minimum) {
  if (typeof version !== "string" || version === "") return false;

  const parts = version.split(".").map((part) => parseInt(part, 10) || 0);
  const wanted = minimum.split(".").map((part) => parseInt(part, 10) || 0);

  for (let i = 0; i < Math.max(parts.length, wanted.length); i++) {
    const a = parts[i] || 0;
    const b = wanted[i] || 0;
    if (a !== b) return a > b;
  }

  return true;
}

function fillProfiles() {
  const select = $("profileSelect");
  const reported = Array.isArray(info.profiles) ? info.profiles : null;
  const offered = reported && reported.length ? reported : FALLBACK_PROFILES;

  select.innerHTML = "";

  for (const key of offered) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = PROFILE_LABELS[key] || key;
    select.appendChild(option);
  }

  // An empty dropdown is never an acceptable end state: say what went wrong
  // and offer to read the sensor again.
  if (select.children.length === 0) {
    showProfileError(
      "Could not load the sensor types from this unit.\n" +
      "לא ניתן לטעון את סוגי החיישנים מהיחידה."
    );
    return;
  }

  $("btnRetryProfiles").hidden = true;

  // What the sensor is already configured for, if anything
  if (info.profile && offered.includes(info.profile)) {
    select.value = info.profile;
  }

  if (info.measureMs) {
    $("measureInterval").value = Math.round(info.measureMs / 1000);
  } else {
    $("measureInterval").value = "";
  }

  // A sensor that already carries this profile has been producing readings
  // on it; it does not have to be re-checked to keep it
  verifiedProfile = info.profileSet ? info.profile : "";
  verifiedDetail = "";

  onProfileChanged();

  // Two situations worth saying out loud rather than papering over

  if (!firmwareAtLeast(info.fw, MIN_FIRMWARE_FOR_PROBE)) {
    showProbe(
      "warn",
      `This sensor runs firmware ${info.fw || "(unknown)"}, which cannot check ` +
      `a sensor type - that needs ${MIN_FIRMWARE_FOR_PROBE} or newer. Wi-Fi, ` +
      `broker and location can still be saved.\n` +
      `הקושחה של החיישן (${info.fw || "לא ידוע"}) לא תומכת בבדיקת סוג חיישן - ` +
      `נדרשת ${MIN_FIRMWARE_FOR_PROBE} ומעלה.`
    );

    return;
  }

  if (!reported || !reported.length) {
    showProbe(
      "warn",
      "This sensor did not report which sensor types it supports, so the list " +
      "above is the one this app knows. Retry to read it again.\n" +
      "החיישן לא דיווח אילו סוגי חיישנים הוא תומך, ולכן הרשימה היא זו שהאפליקציה מכירה."
    );

    $("btnRetryProfiles").hidden = false;
  }
}

function showProfileError(message) {
  showProbe("err", message);

  $("btnRetryProfiles").hidden = false;
}

// Reads the device info again over Bluetooth and repopulates the list. The
// first read can come back trimmed or fail outright, and a person on site
// needs a way to ask again that is not "disconnect and start over".
async function reloadProfiles() {
  if (!chars.info) {
    showProfileError(
      "Not connected to a sensor.\nאין חיבור לחיישן."
    );
    return;
  }

  $("btnRetryProfiles").disabled = true;
  showProbe("info", "Reading the sensor again...", true);

  try {
    const raw = await gatt(() => chars.info.readValue());
    const text = decoder.decode(raw);

    log(`info re-read (${raw.byteLength} bytes): ${text}`);

    info = JSON.parse(text);

    fillForm();
  } catch (error) {
    log(`info re-read ERROR: ${describeError(error)}`);
    $("debugDetails").open = true;

    showProfileError(
      "Could not read the sensor. Keep the phone close to it and try again.\n" +
      "לא ניתן לקרוא מהחיישן. השאר את הטלפון קרוב אליו ונסה שוב."
    );
  } finally {
    $("btnRetryProfiles").disabled = false;
  }
}

function measureMsFromForm() {
  const text = $("measureInterval").value.trim();
  if (text === "") return 0; // the sensor's own default

  const seconds = parseInt(text, 10);
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_MEASURE_SECONDS ||
    seconds > MAX_MEASURE_SECONDS
  ) {
    return null; // invalid
  }

  return seconds * 1000;
}

function onProfileChanged() {
  const selected = $("profileSelect").value;

  if (selected === verifiedProfile) {
    if (verifiedDetail) {
      showProbe("ok", verifiedDetail);
    } else {
      showProbe(
        "info",
        "This sensor is already configured for this type. Press Check to read it now."
      );
    }
    return;
  }

  showProbe(
    "info",
    "Press Check. This sensor type has not been verified on this unit yet."
  );
}

async function probe() {
  const measureMs = measureMsFromForm();

  if (measureMs === null) {
    showProbe(
      "err",
      `Measure every must be ${MIN_MEASURE_SECONDS}-${MAX_MEASURE_SECONDS} seconds, or empty for the sensor default.
זמן הדגימה חייב להיות ${MIN_MEASURE_SECONDS}-${MAX_MEASURE_SECONDS} שניות, או ריק לברירת המחדל של החיישן.`
    );
    return;
  }

  const profile = $("profileSelect").value;

  $("btnProbe").disabled = true;
  $("btnSave").disabled = true;

  showProbe("info", "Checking the sensor...", true);

  try {
    // This check's own number. Answers to earlier commands carry an earlier
    // one and are ignored, whenever they happen to arrive.
    const token = ++commandToken;

    const result = waitForStatus(
      ["probe_ok", "probe_failed"],
      PROBE_TIMEOUT_MS,
      { token, afterSeq: lastStatusSeq }
    );

    const payload =
      JSON.stringify({ probe: profile, measureMs, token }) + "\n";
    const bytes = encoder.encode(payload);

    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      await gatt(() =>
        writeChar(chars.config, bytes.slice(offset, offset + CHUNK_SIZE))
      );
    }

    const status = await result;

    if (status.state === "probe_failed") {
      verifiedProfile = "";
      verifiedDetail = "";
      showProbe(
        "err",
        `${status.message || "The sensor did not answer."}
החיישן לא נמצא או לא החזיר מדידה. בדוק את החיווט ונסה שוב.`
      );
      return;
    }

    verifiedProfile = profile;
    verifiedDetail = status.message || "Sensor verified";
    showProbe("ok", verifiedDetail);
  } catch (error) {
    verifiedProfile = "";
    verifiedDetail = "";
    log(`probe ERROR: ${describeError(error)}`);
    $("debugDetails").open = true;
    showProbe(
      "err",
      `The sensor did not finish the check. Keep the phone close to it and press Check again.
החיישן לא השלים את הבדיקה. השאר את הטלפון קרוב אליו ולחץ Check שוב.`
    );
  } finally {
    $("btnProbe").disabled = false;
    $("btnSave").disabled = false;
  }
}

// ------------------------------------------------------
// Form
// ------------------------------------------------------

function fillForm() {
  const last = loadRemembered();

  // Values from the sensor win; otherwise reuse the last sensor's
  // values (same site, same broker)
  $("broker").value = info.broker || last.broker || "";
  $("port").value = (info.broker ? info.port : last.port) || 1883;
  $("publishInterval").value =
    info.publishInterval || last.publishInterval || DEFAULT_PUBLISH_INTERVAL;
  $("password").value = "";
  let hasLocation = false;
  for (const field of META_FIELDS) {
    const value = info[field] || (!info.broker ? last.meta?.[field] : "") || "";
    $(field).value = value;
    hasLocation ||= value !== "";
  }
  $("locationDetails").open = hasLocation;

  fillProfiles();
}

async function save(event) {
  event.preventDefault();

  const ssid = selectedSsid();
  const broker = $("broker").value.trim();
  const port = parseInt($("port").value, 10) || 1883;

  if (!ssid) {
    showStatus("err", "Select a Wi-Fi network");
    return;
  }
  if (!broker) {
    showStatus("err", "Enter the broker IP address");
    return;
  }
  const publishInterval = parseInt($("publishInterval").value, 10);
  if (
    !Number.isInteger(publishInterval) ||
    publishInterval < MIN_PUBLISH_INTERVAL ||
    publishInterval > MAX_PUBLISH_INTERVAL
  ) {
    showStatus("err", `Publish interval must be ${MIN_PUBLISH_INTERVAL}-${MAX_PUBLISH_INTERVAL} seconds`);
    return;
  }

  const profile = $("profileSelect").value;
  const measureMs = measureMsFromForm();

  if (measureMs === null) {
    showStatus(
      "err",
      `Measure every must be ${MIN_MEASURE_SECONDS}-${MAX_MEASURE_SECONDS} seconds, or empty for the sensor default.
זמן הדגימה חייב להיות ${MIN_MEASURE_SECONDS}-${MAX_MEASURE_SECONDS} שניות, או ריק לברירת המחדל של החיישן.`
    );
    return;
  }

  // The firmware refuses this too. Checking here as well means the person
  // is told before anything is sent, and in both languages.
  if (profile !== verifiedProfile) {
    showStatus(
      "err",
      `Press Check first. A sensor type is only saved once this unit has actually read it.
לחץ Check קודם. סוג החיישן נשמר רק אחרי שהיחידה הזו באמת קראה ממנו מדידה.`
    );
    return;
  }

  const meta = {};
  for (const field of META_FIELDS) {
    meta[field] = $(field).value.trim();
  }

  const payload = JSON.stringify({
    ssid,
    password: $("password").value,
    broker,
    port,
    publishInterval,
    profile,
    measureMs,
    meta
  }) + "\n";

  saving = true;
  setBusy(true);
  showStatus("info", "Sending configuration...", true);

  try {
    const token = ++commandToken;

    const result = waitForStatus(
      ["saved", "failed"],
      45000,
      { token, afterSeq: lastStatusSeq }
    );

    const bytes = encoder.encode(payload);
    for (let offset = 0; offset < bytes.length; offset += CHUNK_SIZE) {
      const chunk = bytes.slice(offset, offset + CHUNK_SIZE);
      await gatt(() => writeChar(chars.config, chunk));
    }

    const status = await result;

    if (status.state === "failed") {
      saving = false;
      setBusy(false);
      showStatus("err", status.message || "Configuration failed");
      return;
    }

    remember({ ssid, broker, port, publishInterval, meta });

    $("resProfile").textContent =
      (PROFILE_LABELS[profile] || profile) +
      (measureMs ? `, every ${measureMs / 1000} s` : "");

    $("resDevice").textContent = info.id;
    $("resIp").textContent = status.ip || "-";
    $("resSsid").textContent = ssid;
    $("resBroker").textContent = `${broker}:${port}`;
    $("resWeb").textContent = status.ip ? `http://${status.ip}  (user: admin)` : "user: admin";

    if (status.broker) {
      showStatus("ok", "Connected to Wi-Fi and broker");
    } else {
      showStatus("warn", `Saved, but broker ${broker}:${port} is not reachable. Check the broker is running.`);
    }

    showStep("stepResult");
  } catch (error) {
    saving = false;
    setBusy(false);
    showStatus("err", `Saving failed: ${describeError(error)}. Keep the phone close to the sensor and try again.
השמירה נכשלה. השאר את הטלפון קרוב לחיישן ונסה שוב.`);
  }
}

function next() {
  saving = false;
  disconnect();
  device = null;
  chars = {};
  info = {};

  // A check belongs to the unit it ran on. Carrying it to the next sensor
  // would let one unit's reading vouch for another's wiring.
  verifiedProfile = "";
  verifiedDetail = "";
  $("probeResult").className = "status";

  setBusy(false);
  $("headerDevice").textContent = "";
  hideStatus();
  showStep("stepConnect");
}

// ------------------------------------------------------
// Init
// ------------------------------------------------------

// The page shows the mismatch banner by default; a script of the right
// version hides it. If this file is the wrong one, nothing hides it.
(function checkAppVersion() {
  const expected =
    document.body.getAttribute("data-app-version") || "";

  const banner = $("staleApp");

  if (expected === APP_VERSION) {
    banner.className = "status";
    return;
  }

  // Wrong pairing of page and script: clear everything cached and reload
  $("btnHardReload").addEventListener("click", async () => {
    try {
      if (navigator.serviceWorker) {
        const registrations =
          await navigator.serviceWorker.getRegistrations();

        await Promise.all(registrations.map((r) => r.unregister()));
      }

      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
    } catch {
      // Nothing more to clean up; reload anyway
    }

    location.replace(
      location.pathname + "?reload=" + Date.now()
    );
  });
})();

$("btnConnect").addEventListener("click", connect);
$("btnScan").addEventListener("click", scan);
$("btnProbe").addEventListener("click", probe);
$("btnRetryProfiles").addEventListener("click", reloadProfiles);
$("profileSelect").addEventListener("change", onProfileChanged);
$("ssidSelect").addEventListener("change", onSsidChanged);
$("ssidManual").addEventListener("input", onSsidChanged);
$("stepConfig").addEventListener("submit", save);
$("btnNext").addEventListener("click", next);

if (!navigator.bluetooth) {
  $("unsupported").classList.remove("hidden");
  $("btnConnect").disabled = true;
}

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(() => {});
}
