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

function waitForStatus(states, timeoutMs) {
  return new Promise((resolve, reject) => {
    const waiter = { states, resolve };
    statusWaiters.push(waiter);
    setTimeout(() => {
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

  if (status.state === "connecting") {
    showStatus("info", status.message || "Connecting to Wi-Fi...", true);
  } else if (status.state === "testing_broker") {
    showStatus("info", `Wi-Fi connected (${status.ip}). Checking broker...`, true);
  } else if (status.state === "scanning") {
    showStatus("info", "Scanning Wi-Fi networks...", true);
  }

  for (const waiter of [...statusWaiters]) {
    if (waiter.states.includes(status.state)) {
      statusWaiters = statusWaiters.filter((w) => w !== waiter);
      waiter.resolve(status);
    }
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
    meta
  }) + "\n";

  saving = true;
  setBusy(true);
  showStatus("info", "Sending configuration...", true);

  try {
    const result = waitForStatus(["saved", "failed"], 45000);

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
  setBusy(false);
  $("headerDevice").textContent = "";
  hideStatus();
  showStep("stepConnect");
}

// ------------------------------------------------------
// Init
// ------------------------------------------------------

$("btnConnect").addEventListener("click", connect);
$("btnScan").addEventListener("click", scan);
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
