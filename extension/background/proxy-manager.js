/**
 * ProxyManager - Manages chrome.proxy API for VPN mode.
 * Connects to a peer node in the selected country via
 * the signaling server, then routes all browser traffic
 * through that peer using PAC script.
 *
 * Auto-reconnect: on proxy error, tries another node
 * in the same country (up to MAX_RETRIES).
 */

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;

export class ProxyManager {
  constructor() {
    this.currentProxy = null;
    this.currentCountry = null;
    this.peerConnection = null;
    this.failedAddrs = new Set();
    this.retryCount = 0;
    this._reconnecting = false;

    // Listen for proxy errors and auto-reconnect
    chrome.proxy.onProxyError.addListener((details) => {
      console.warn(`[Bandwi] Proxy error: ${details.error}`);
      if (this.currentCountry && !this._reconnecting) {
        this._autoReconnect();
      }
    });
  }

  async connect(country) {
    this.currentCountry = country;
    this.failedAddrs.clear();
    this.retryCount = 0;
    return this._connectToNode(country);
  }

  async _connectToNode(country) {
    const node = await this._findNode(country);
    if (!node) {
      console.warn(`[Bandwi] No available node in ${country}`);
      return false;
    }

    this.currentProxy = node;

    const pType = node.proxyType || "socks5";
    let proxyDirective;
    if (pType === "http" || pType === "https") {
      proxyDirective = `PROXY ${node.addr}`;
    } else if (pType === "socks4") {
      proxyDirective = `SOCKS ${node.addr}`;
    } else {
      proxyDirective = `SOCKS5 ${node.addr}`;
    }

    const config = {
      mode: "pac_script",
      pacScript: {
        data: `function FindProxyForURL(url, host) {
          if (isPlainHostName(host) || host === "localhost") {
            return "DIRECT";
          }
          return "${proxyDirective}; DIRECT";
        }`,
      },
    };

    await chrome.proxy.settings.set({ value: config, scope: "regular" });
    console.log(`[Bandwi] VPN connected via ${node.addr} (${country})`);
    return true;
  }

  async _autoReconnect() {
    if (this._reconnecting || this.retryCount >= MAX_RETRIES) {
      if (this.retryCount >= MAX_RETRIES) {
        console.warn("[Bandwi] Max retries reached, disconnecting");
        await this.disconnect();
      }
      return;
    }

    this._reconnecting = true;
    this.retryCount++;

    // Mark current node as failed
    if (this.currentProxy) {
      this.failedAddrs.add(this.currentProxy.addr);
    }

    console.log(
      `[Bandwi] Auto-reconnect attempt ${this.retryCount}/${MAX_RETRIES}`
    );

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

    const ok = await this._connectToNode(this.currentCountry);
    this._reconnecting = false;

    if (!ok) {
      // Try again if retries remain
      this._autoReconnect();
    } else {
      console.log("[Bandwi] Auto-reconnect successful");
    }
  }

  async disconnect() {
    await chrome.proxy.settings.clear({ scope: "regular" });
    this.currentProxy = null;
    this.currentCountry = null;
    this.failedAddrs.clear();
    this.retryCount = 0;
    this._reconnecting = false;

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    console.log("[Bandwi] VPN disconnected");
  }

  async _findNode(country) {
    try {
      const resp = await fetch(
        `https://bandwi-signaling.dlawodnjs.workers.dev/api/nodes?country=${country}`
      );
      if (!resp.ok) return null;
      const nodes = await resp.json();
      // Exclude previously failed nodes
      const available = nodes.filter((n) => !this.failedAddrs.has(n.addr));
      if (!available.length) return null;
      // Pick random node for load distribution
      return available[Math.floor(Math.random() * available.length)];
    } catch {
      return null;
    }
  }
}
