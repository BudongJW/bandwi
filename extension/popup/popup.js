const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const btnConnect = $("btnConnect");
const nodeToggle = $("nodeToggle");
const nodeStats = $("nodeStats");
const bwLimit = $("bwLimit");
const bwValue = $("bwValue");

let vpnConnected = false;

// ── VPN Connect / Disconnect ───────────────────────────────
btnConnect.addEventListener("click", async () => {
  if (vpnConnected) {
    await chrome.runtime.sendMessage({ type: "vpn:disconnect" });
    setVpnState(false);
  } else {
    const country = $("country").value;
    await chrome.runtime.sendMessage({ type: "vpn:connect", country });
    setVpnState(true);
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
