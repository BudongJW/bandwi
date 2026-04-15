/**
 * ProxyManager - Manages chrome.proxy API for VPN mode.
 *
 * All VPN state persisted to chrome.storage.local (survives SW hibernation).
 * Verifies proxy connectivity before committing.
 * Auto-reconnects to another node on failure.
 *
 * Key design: signaling server and verification URLs always bypass the proxy
 * via PAC script DIRECT rules, so fetches never go through the proxy being tested.
 */

const MAX_CONNECT_ATTEMPTS = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const VERIFY_TIMEOUT_MS = 8000;
const SIGNALING_HOST = "bandwi-signaling.dlawodnjs.workers.dev";
const VERIFY_HOST = "httpbin.org";

export class ProxyManager {
  constructor() {
    this.currentProxy = null;
    this.currentCountry = null;
    this.failedAddrs = new Set();
    this.retryCount = 0;
    this._reconnecting = false;
    this._connectionSeq = 0;

    chrome.proxy.onProxyError.addListener((details) => {
      console.warn(`[Bandwi] Proxy error: ${details.error}`);
      if (this.currentCountry && !this._reconnecting) {
        this._autoReconnect();
      }
    });
  }

  // Restore state from storage and re-apply PAC script
  async restore() {
    const stored = await chrome.storage.local.get([
      "vpnStatus",
      "vpnCountry",
      "vpnProxy",
    ]);

    // Clear stale "connecting" state (SW died mid-connect)
    if (stored.vpnStatus === "connecting") {
      await chrome.storage.local.set({ vpnStatus: "disconnected" });
      return false;
    }

    if (stored.vpnStatus === "connected" && stored.vpnCountry && stored.vpnProxy) {
      this.currentCountry = stored.vpnCountry;
      this.currentProxy = stored.vpnProxy;
      // Re-apply PAC script (chrome.proxy doesn't persist across SW restarts)
      await this._applyPac(stored.vpnProxy);
      return true;
    }
    return false;
  }

  async connect(country) {
    this.currentCountry = country;
    this.failedAddrs.clear();
    this.retryCount = 0;
    const seq = ++this._connectionSeq;

    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      if (this._connectionSeq !== seq) return false; // cancelled

      const node = await this._findNode(country);
      if (!node) {
        console.warn(`[Bandwi] No more nodes in ${country}`);
        break;
      }

      const ok = await this._applyAndVerify(node);
      if (this._connectionSeq !== seq) return false; // cancelled

      if (ok) return true;

      this.failedAddrs.add(node.addr);
      // Clear proxy before trying next node
      await chrome.proxy.settings.clear({ scope: "regular" });
      console.log(
        `[Bandwi] Node ${node.addr} failed (${i + 1}/${MAX_CONNECT_ATTEMPTS})`
      );
    }

    await chrome.proxy.settings.clear({ scope: "regular" });
    return false;
  }

  async _applyPac(node) {
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
          if (isPlainHostName(host) || host === "localhost") return "DIRECT";
          if (host === "${SIGNALING_HOST}") return "DIRECT";
          if (host === "${VERIFY_HOST}") return "DIRECT";
          return "${proxyDirective}";
        }`,
      },
    };

    await chrome.proxy.settings.set({ value: config, scope: "regular" });
  }

  async _applyAndVerify(node) {
    this.currentProxy = node;
    const pType = node.proxyType || "socks5";

    // Apply PAC with DIRECT bypass for verification URL
    await this._applyPac(node);

    // Verify: fetch through the proxy to confirm it works
    // We need to test a URL that DOES go through the proxy
    // Use a non-bypassed URL for the actual verification
    const works = await this._verifyConnectivity();
    if (!works) return false;

    // Persist state
    await chrome.storage.local.set({
      vpnStatus: "connected",
      vpnConnected: true,
      vpnCountry: this.currentCountry,
      vpnProxy: { addr: node.addr, country: node.country, proxyType: pType },
    });

    console.log(
      `[Bandwi] VPN connected via ${node.addr} (${this.currentCountry})`
    );
    return true;
  }

  async _verifyConnectivity() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

      // httpbin.org is in the DIRECT bypass list, so this tests direct connectivity
      // To test the proxy itself, we fetch a different URL that goes through the proxy
      const resp = await fetch("http://ip-api.com/json/?fields=query,country", {
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (!resp.ok) return false;
      const data = await resp.json();
      console.log(`[Bandwi] Proxy verified, exit IP: ${data.query}`);
      return true;
    } catch {
      return false;
    }
  }

  async _autoReconnect() {
    if (this._reconnecting || this.retryCount >= MAX_RETRIES) {
      if (this.retryCount >= MAX_RETRIES) {
        console.warn("[Bandwi] Max retries reached, disconnecting");
        await this.disconnect();
        await chrome.storage.local.set({ vpnStatus: "disconnected" });
      }
      return;
    }

    this._reconnecting = true;
    this.retryCount++;

    if (this.currentProxy) {
      this.failedAddrs.add(this.currentProxy.addr);
    }

    // Clear broken proxy before finding a new node
    await chrome.proxy.settings.clear({ scope: "regular" });

    console.log(
      `[Bandwi] Auto-reconnect attempt ${this.retryCount}/${MAX_RETRIES}`
    );

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

    const node = await this._findNode(this.currentCountry);
    if (node) {
      const ok = await this._applyAndVerify(node);
      if (ok) {
        this.retryCount = 0;
        this._reconnecting = false;
        console.log("[Bandwi] Auto-reconnect successful");
        return;
      }
    }

    this._reconnecting = false;
    if (this.retryCount < MAX_RETRIES) {
      this._autoReconnect();
    } else {
      await this.disconnect();
      await chrome.storage.local.set({ vpnStatus: "disconnected" });
    }
  }

  async disconnect() {
    this._connectionSeq++;
    await chrome.proxy.settings.clear({ scope: "regular" });
    this.currentProxy = null;
    this.currentCountry = null;
    this.failedAddrs.clear();
    this.retryCount = 0;
    this._reconnecting = false;

    await chrome.storage.local.set({ vpnStatus: "disconnected" });
    await chrome.storage.local.remove([
      "vpnConnected",
      "vpnCountry",
      "vpnProxy",
    ]);

    console.log("[Bandwi] VPN disconnected");
  }

  async _findNode(country) {
    try {
      // Signaling server is in PAC DIRECT bypass list, always reachable
      const resp = await fetch(
        `https://${SIGNALING_HOST}/api/nodes?country=${country}`
      );
      if (!resp.ok) return null;
      const nodes = await resp.json();
      const available = nodes.filter((n) => !this.failedAddrs.has(n.addr));
      if (!available.length) return null;
      return available[Math.floor(Math.random() * available.length)];
    } catch {
      return null;
    }
  }
}
