const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const btnConnect = $("btnConnect");
const nodeToggle = $("nodeToggle");
const nodeStats = $("nodeStats");
const bwLimit = $("bwLimit");
const bwValue = $("bwValue");

const countryHint = $("countryHint");
const API_BASE = "https://bandwi-signaling.dlawodnjs.workers.dev";
const COUNTRY_NAMES = {
  KR: "South Korea",
  US: "United States",
  JP: "Japan",
  SG: "Singapore",
  DE: "Germany",
  GB: "United Kingdom",
  FR: "France",
  CA: "Canada",
  AU: "Australia",
  IN: "India",
};

let vpnConnected = false;

// ── Load Available Countries from Server ───────────────────
(async function loadCountries() {
  const select = $("country");
  try {
    const resp = await fetch(`${API_BASE}/api/nodes`);
    const nodes = await resp.json();
    // Collect unique countries with node counts
    const countryMap = {};
    for (const n of nodes) {
      countryMap[n.country] = (countryMap[n.country] || 0) + 1;
    }
    const countries = Object.entries(countryMap).sort((a, b) => b[1] - a[1]);

    select.innerHTML = "";
    if (countries.length === 0) {
      select.innerHTML = '<option value="" disabled selected>No nodes available</option>';
      countryHint.textContent = "Waiting for peer nodes to come online...";
      btnConnect.disabled = true;
    } else {
      for (const [code, count] of countries) {
        const name = COUNTRY_NAMES[code] || code;
        const opt = document.createElement("option");
        opt.value = code;
        opt.textContent = `${name} (${count} node${count > 1 ? "s" : ""})`;
        select.appendChild(opt);
      }
      countryHint.textContent = `${countries.length} country available`;
      btnConnect.disabled = false;
    }
  } catch {
    select.innerHTML = '<option value="" disabled selected>Server offline</option>';
    countryHint.textContent = "Could not reach signaling server";
    btnConnect.disabled = true;
  }
})();

// ── VPN Connect / Disconnect ───────────────────────────────
btnConnect.addEventListener("click", async () => {
  if (vpnConnected) {
    await chrome.runtime.sendMessage({ type: "vpn:disconnect" });
    setVpnState(false);
  } else {
    const country = $("country").value;
    if (!country) return;
    const result = await chrome.runtime.sendMessage({ type: "vpn:connect", country });
    if (result && result.ok) {
      setVpnState(true);
      countryHint.textContent = "";
    } else {
      countryHint.textContent = "No available node in this country";
    }
  }
});

function setVpnState(connected) {
  vpnConnected = connected;
  statusDot.className = "status-indicator" + (connected ? " connected" : "");
  statusText.textContent = connected ? "VPN Connected" : "Disconnected";
  btnConnect.textContent = connected ? "Disconnect" : "Connect";
  btnConnect.classList.toggle("active", connected);
}

// ── Node Contribution Toggle ───────────────────────────────
nodeToggle.addEventListener("change", async () => {
  const enabled = nodeToggle.checked;
  await chrome.runtime.sendMessage({ type: "node:toggle", enabled });
  nodeStats.style.display = enabled ? "block" : "none";
  if (!vpnConnected) {
    statusDot.className =
      "status-indicator" + (enabled ? " node-active" : "");
    statusText.textContent = enabled ? "Node Active" : "Disconnected";
  }
});

// ── Bandwidth Slider ───────────────────────────────────────
bwLimit.addEventListener("input", () => {
  bwValue.textContent = bwLimit.value;
  chrome.runtime.sendMessage({
    type: "settings:bwLimit",
    value: Number(bwLimit.value),
  });
});

// ── Restore State on Popup Open ────────────────────────────
(async function restore() {
  const state = await chrome.runtime.sendMessage({ type: "state:get" });
  if (!state) return;

  if (state.vpnConnected) setVpnState(true);

  nodeToggle.checked = state.nodeEnabled;
  nodeStats.style.display = state.nodeEnabled ? "block" : "none";
  if (state.nodeEnabled) {
    $("peerCount").textContent = state.peerCount || 0;
    $("dataRelayed").textContent = formatBytes(state.dataRelayed || 0);
    $("uptime").textContent = formatUptime(state.uptimeMs || 0);
    if (!state.vpnConnected) {
      statusDot.className = "status-indicator node-active";
      statusText.textContent = "Node Active";
    }
  }

  if (state.bwLimit) {
    bwLimit.value = state.bwLimit;
    bwValue.textContent = state.bwLimit;
  }
})();

// ── Helpers ────────────────────────────────────────────────
function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatUptime(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return m + "m";
  const h = Math.floor(m / 60);
  return h + "h " + (m % 60) + "m";
}
