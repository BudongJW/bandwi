const $ = (id) => document.getElementById(id);

const statusDot = $("statusDot");
const statusText = $("statusText");
const btnConnect = $("btnConnect");
const nodeToggle = $("nodeToggle");
const nodeStats = $("nodeStats");
const bwLimit = $("bwLimit");
const bwValue = $("bwValue");

const countryHint = $("countryHint");
const statusDetail = $("statusDetail");
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
  CN: "China",
  VN: "Vietnam",
  NL: "Netherlands",
  ID: "Indonesia",
  IR: "Iran",
  RU: "Russia",
  BR: "Brazil",
  TH: "Thailand",
  HK: "Hong Kong",
};

// ── UI Updaters ────────────────────────────────────────────
function applyVpnStatus(status, proxy, country) {
  const select = $("country");

  switch (status) {
    case "connecting":
      statusDot.className = "status-indicator";
      statusText.textContent = "Connecting...";
      statusDetail.textContent = country
        ? COUNTRY_NAMES[country] || country
        : "";
      btnConnect.textContent = "Connecting...";
      btnConnect.disabled = true;
      select.disabled = true;
      break;

    case "connected":
      statusDot.className = "status-indicator connected";
      statusText.textContent = "VPN Connected";
      btnConnect.textContent = "Disconnect";
      btnConnect.disabled = false;
      btnConnect.classList.add("active");
      select.disabled = true;
      countryHint.textContent = "";
      if (proxy) {
        const cName = COUNTRY_NAMES[proxy.country] || proxy.country;
        const exitIp = proxy.exitIp || proxy.addr;
        statusDetail.textContent = `${cName} / ${exitIp} (${proxy.proxyType})`;
        // Show connected country in dropdown
        select.innerHTML = "";
        const opt = document.createElement("option");
        opt.value = proxy.country;
        opt.textContent = cName;
        opt.selected = true;
        select.appendChild(opt);
      }
      break;

    case "failed":
      statusDot.className = "status-indicator";
      statusText.textContent = "Connection Failed";
      statusDetail.textContent = "";
      btnConnect.textContent = "Connect";
      btnConnect.disabled = false;
      btnConnect.classList.remove("active");
      select.disabled = false;
      countryHint.textContent = "Failed - try another country";
      break;

    default: // "disconnected" or unknown
      statusDot.className = "status-indicator";
      statusText.textContent = "Disconnected";
      statusDetail.textContent = "";
      btnConnect.textContent = "Connect";
      btnConnect.disabled = false;
      btnConnect.classList.remove("active");
      select.disabled = false;
      break;
  }
}

// ── Listen for storage changes (connection state updates) ──
chrome.storage.onChanged.addListener((changes) => {
  if (changes.vpnStatus) {
    const status = changes.vpnStatus.newValue;
    const proxy = changes.vpnProxy?.newValue || null;
    const country = changes.vpnCountry?.newValue || null;
    applyVpnStatus(status, proxy, country);

    // Reload countries when disconnected
    if (status === "disconnected") {
      loadCountries();
    }
  }
});

// ── Init ───────────────────────────────────────────────────
(async function init() {
  // Read all state from storage
  const stored = await chrome.storage.local.get([
    "vpnStatus",
    "vpnCountry",
    "vpnProxy",
    "cachedCountries",
  ]);

  const status = stored.vpnStatus || "disconnected";
  applyVpnStatus(status, stored.vpnProxy, stored.vpnCountry);

  // Restore node/settings state from service worker
  let state = null;
  try {
    state = await chrome.runtime.sendMessage({ type: "state:get" });
  } catch {
    // SW not ready yet, use storage fallback
  }
  if (state) {
    nodeToggle.checked = state.nodeEnabled;
    nodeStats.style.display = state.nodeEnabled ? "block" : "none";
    if (state.nodeEnabled) {
      $("peerCount").textContent = state.peerCount || 0;
      $("dataRelayed").textContent = formatBytes(state.dataRelayed || 0);
      $("uptime").textContent = formatUptime(state.uptimeMs || 0);
      if (status !== "connected") {
        statusDot.className = "status-indicator node-active";
        statusText.textContent = "Node Active";
      }
    }
    if (state.bwLimit) {
      bwLimit.value = state.bwLimit;
      bwValue.textContent = state.bwLimit;
    }
  }

  // Load country list when not connected/connecting
  if (status === "disconnected" || status === "failed") {
    // Show cached instantly
    if (stored.cachedCountries?.length) {
      renderCountries(stored.cachedCountries);
    }
    loadCountries();
  }
})();

async function loadCountries() {
  try {
    const result = await chrome.runtime.sendMessage({ type: "nodes:list" });
    if (result?.countries?.length) {
      renderCountries(result.countries);
    }
  } catch {
    // Use cached if available
    const cached = await chrome.storage.local.get("cachedCountries");
    if (cached.cachedCountries?.length) {
      renderCountries(cached.cachedCountries);
    } else {
      const select = $("country");
      select.innerHTML =
        '<option value="" disabled selected>Server offline</option>';
      countryHint.textContent = "Could not reach signaling server";
      btnConnect.disabled = true;
    }
  }
}

function renderCountries(countries) {
  const select = $("country");
  select.innerHTML = "";
  if (countries.length === 0) {
    select.innerHTML =
      '<option value="" disabled selected>No nodes available</option>';
    countryHint.textContent = "Waiting for peer nodes to come online...";
    btnConnect.disabled = true;
    return;
  }
  for (const { code, count } of countries) {
    const name = COUNTRY_NAMES[code] || code;
    const opt = document.createElement("option");
    opt.value = code;
    opt.textContent = `${name} (${count} node${count > 1 ? "s" : ""})`;
    select.appendChild(opt);
  }
  countryHint.textContent = `${countries.length} countries available`;
  btnConnect.disabled = false;
}

// ── VPN Connect / Disconnect ───────────────────────────────
btnConnect.addEventListener("click", async () => {
  const stored = await chrome.storage.local.get("vpnStatus");
  if (stored.vpnStatus === "connected") {
    await chrome.runtime.sendMessage({ type: "vpn:disconnect" });
    // UI will update via storage.onChanged listener
  } else {
    const country = $("country").value;
    if (!country) return;
    // Fire and forget - SW handles the rest, popup follows via storage
    chrome.runtime.sendMessage({ type: "vpn:connect", country });
    applyVpnStatus("connecting", null, country);
  }
});

// ── Node Contribution Toggle ───────────────────────────────
nodeToggle.addEventListener("change", async () => {
  const enabled = nodeToggle.checked;
  await chrome.runtime.sendMessage({ type: "node:toggle", enabled });
  nodeStats.style.display = enabled ? "block" : "none";
  const stored = await chrome.storage.local.get("vpnStatus");
  if (stored.vpnStatus !== "connected") {
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
