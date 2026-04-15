/**
 * Bandwi Service Worker
 * Manages VPN proxy routing and P2P node lifecycle.
 * All connection state persisted to chrome.storage.local
 * to survive MV3 service worker hibernation.
 */

import { PeerNode } from "./peer-node.js";
import { ProxyManager } from "./proxy-manager.js";

const SIGNALING_URL = "wss://bandwi-signaling.dlawodnjs.workers.dev";

const state = {
  vpnConnected: false,
  nodeEnabled: false,
  peerCount: 0,
  dataRelayed: 0,
  uptimeMs: 0,
  uptimeStart: null,
  bwLimit: 10,
};

const peerNode = new PeerNode(SIGNALING_URL);
const proxyManager = new ProxyManager();

// ── Message Handler ────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target === "offscreen") return false;

  (async () => {
    switch (msg.type) {
      case "vpn:connect": {
        const country = msg.country;
        // Respond immediately so popup doesn't block
        await chrome.storage.local.set({
          vpnStatus: "connecting",
          vpnCountry: country,
        });
        sendResponse({ ok: true, status: "connecting" });

        // Connection runs independently of popup lifecycle
        const ok = await proxyManager.connect(country);
        state.vpnConnected = !!ok;

        if (ok) {
          // proxyManager.connect() already saved to storage
          // Just sync in-memory state
        } else {
          await chrome.storage.local.set({
            vpnStatus: "failed",
            vpnProxy: null,
          });
          setTimeout(async () => {
            const cur = await chrome.storage.local.get("vpnStatus");
            if (cur.vpnStatus === "failed") {
              await chrome.storage.local.set({ vpnStatus: "disconnected" });
            }
          }, 3000);
        }
        return;
      }

      case "vpn:disconnect":
        await proxyManager.disconnect();
        state.vpnConnected = false;
        break;

      case "node:toggle":
        if (msg.enabled) {
          if (peerNode.running) await peerNode.stop();
          await peerNode.start(state.bwLimit);
          state.nodeEnabled = true;
          state.uptimeStart = Date.now();
        } else {
          await peerNode.stop();
          state.nodeEnabled = false;
          state.uptimeStart = null;
          state.peerCount = 0;
          state.dataRelayed = 0;
          state.uptimeMs = 0;
        }
        await chrome.storage.local.set({ nodeEnabled: state.nodeEnabled });
        break;

      case "settings:bwLimit":
        state.bwLimit = msg.value;
        peerNode.setBandwidthLimit(msg.value);
        await chrome.storage.local.set({ bwLimit: msg.value });
        break;

      case "nodes:list": {
        try {
          const resp = await fetch(
            "https://bandwi-signaling.dlawodnjs.workers.dev/api/nodes"
          );
          const nodes = await resp.json();
          const countryMap = {};
          for (const n of nodes) {
            countryMap[n.country] = (countryMap[n.country] || 0) + 1;
          }
          const countries = Object.entries(countryMap)
            .sort((a, b) => b[1] - a[1])
            .map(([code, count]) => ({ code, count }));
          await chrome.storage.local.set({
            cachedCountries: countries,
            cachedAt: Date.now(),
          });
          sendResponse({ ok: true, countries });
        } catch {
          const cached = await chrome.storage.local.get("cachedCountries");
          sendResponse({
            ok: false,
            countries: cached.cachedCountries || [],
          });
        }
        return;
      }

      case "state:get":
        if (state.uptimeStart) {
          state.uptimeMs = Date.now() - state.uptimeStart;
        }
        state.peerCount = peerNode.getPeerCount();
        state.dataRelayed = peerNode.getDataRelayed();
        sendResponse({ ...state });
        return;
    }
    sendResponse({ ok: true });
  })();
  return true;
});

// ── Auto-enable node sharing on first install ─────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    await peerNode.start(state.bwLimit);
    state.nodeEnabled = true;
    state.uptimeStart = Date.now();
    await chrome.storage.local.set({ nodeEnabled: true });
  }
});

// ── Restore all state when service worker wakes up ────────
(async () => {
  const stored = await chrome.storage.local.get(["nodeEnabled", "bwLimit"]);

  // Restore bandwidth setting
  if (stored.bwLimit) state.bwLimit = stored.bwLimit;

  // Restore node state
  if (stored.nodeEnabled && !state.nodeEnabled) {
    await peerNode.start(state.bwLimit);
    state.nodeEnabled = true;
    state.uptimeStart = Date.now();
  }

  // Restore VPN state (re-applies PAC script, clears stale "connecting")
  const vpnRestored = await proxyManager.restore();
  if (vpnRestored) {
    state.vpnConnected = true;
  }
})();

// ── Keep-alive alarm ──────────────────────────────────────
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && state.nodeEnabled) {
    peerNode.heartbeat();
  }
});
