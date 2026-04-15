/**
 * Bandwi Service Worker
 * Manages VPN proxy routing and P2P node lifecycle.
 */

import { PeerNode } from "./peer-node.js";
import { ProxyManager } from "./proxy-manager.js";

// Production: wss://bandwi-signaling.<your-subdomain>.workers.dev
// Local dev:  ws://localhost:8787
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
  (async () => {
    switch (msg.type) {
      case "vpn:connect": {
        const ok = await proxyManager.connect(msg.country);
        state.vpnConnected = !!ok;
        sendResponse({ ok: !!ok, vpnConnected: state.vpnConnected });
        return;
      }

      case "vpn:disconnect":
        await proxyManager.disconnect();
        state.vpnConnected = false;
        break;

      case "node:toggle":
        if (msg.enabled) {
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
        break;

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
  return true; // async sendResponse
});

// ── Auto-enable node sharing on first install ─────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === "install") {
    // Free users share their node by default
    await peerNode.start(state.bwLimit);
    state.nodeEnabled = true;
    state.uptimeStart = Date.now();
    await chrome.storage.local.set({ nodeEnabled: true });
  }
});

// Restore node state when service worker wakes up
(async () => {
  const stored = await chrome.storage.local.get("nodeEnabled");
  if (stored.nodeEnabled && !state.nodeEnabled) {
    await peerNode.start(state.bwLimit);
    state.nodeEnabled = true;
    state.uptimeStart = Date.now();
  }
})();

// ── Keep-alive alarm (Manifest V3 service workers can idle) ─
chrome.alarms.create("keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "keepalive" && state.nodeEnabled) {
    peerNode.heartbeat();
  }
});
