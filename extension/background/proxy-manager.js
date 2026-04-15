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
    // Also clear any leftover PAC script from the interrupted connection
    if (stored.vpnStatus === "connecting") {
      try {
        await chrome.proxy.settings.set({
          value: { mode: "direct" },
          scope: "regular",
        });
      } catch {}
      await chrome.proxy.settings.clear({ scope: "regular" });
      await chrome.storage.local.set({ vpnStatus: "disconnected" });
      await chrome.storage.local.remove(["vpnConnected", "vpnCountry", "vpnProxy"]);
      return false;
    }

    if (stored.vpnStatus === "connected" && stored.vpnCountry && stored.vpnProxy) {
      this.currentCountry = stored.vpnCountry;
      this.currentProxy = stored.vpnProxy;
      // Re-apply PAC script (chrome.proxy doesn't persist across SW restarts)
      await this._applyPac(stored.vpnProxy);
      return true;
    }

    // No VPN state but PAC might be lingering from a crash
    if (!stored.vpnStatus || stored.vpnStatus === "disconnected") {
      try {
        await chrome.proxy.settings.set({
          value: { mode: "direct" },
          scope: "regular",
        });
      } catch {}
      await chrome.proxy.settings.clear({ scope: "regular" });
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
          if (host === "ip-api.com") return "DIRECT";
          return "${proxyDirective}; DIRECT";
        }`,
      },
    };

    await chrome.proxy.settings.set({ value: config, scope: "regular" });
  }

  async _applyAndVerify(node) {
    this.currentProxy = node;
    const pType = node.proxyType || "socks5";

    await this._applyPac(node);

    // Verify proxy works and get actual exit IP/country
    const exitInfo = await this._verifyConnectivity();
    if (!exitInfo) return false;

    // Use actual exit country from verification, not the registered country
    const proxyInfo = {
      addr: node.addr,
      country: exitInfo.countryCode || node.country,
      proxyType: pType,
      exitIp: exitInfo.ip,
    };

    this.currentProxy = proxyInfo;

    await chrome.storage.local.set({
      vpnStatus: "connected",
      vpnConnected: true,
      vpnCountry: this.currentCountry,
      vpnProxy: proxyInfo,
    });

    console.log(
      `[Bandwi] VPN connected via ${node.addr}, exit IP: ${exitInfo.ip} (${exitInfo.countryCode})`
    );
    return true;
  }

  // Returns { ip, countryCode } or null on failure
  async _verifyConnectivity() {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), VERIFY_TIMEOUT_MS);

      const resp = await fetch(
        "http://ip-api.com/json/?fields=query,countryCode",
        { signal: controller.signal }
      );
      clearTimeout(timer);

      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.query) return null;
      console.log(`[Bandwi] Proxy verified, exit: ${data.query} (${data.countryCode})`);
      return { ip: data.query, countryCode: data.countryCode };
    } catch {
      return null;
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

    // Force immediate DIRECT, then clear — ensures no stale PAC lingers
    try {
      await chrome.proxy.settings.set({
        value: { mode: "direct" },
        scope: "regular",
      });
    } catch {}
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
      const resp = await fetch(
        `https://${SIGNALING_HOST}/api/nodes?country=${country}`
      );
      if (!resp.ok) return null;
      const nodes = await resp.json();
      const available = nodes.filter((n) => !this.failedAddrs.has(n.addr));
      if (!available.length) return null;

      // Prefer SOCKS5 > SOCKS4 > HTTP
      // HTTP proxies break HTTPS (SSL MITM / ERR_CERT_AUTHORITY_INVALID)
      const socks5 = available.filter((n) => (n.proxyType || n.type) === "socks5");
      const socks4 = available.filter((n) => (n.proxyType || n.type) === "socks4");
      const pool = socks5.length ? socks5 : socks4.length ? socks4 : available;

      return pool[Math.floor(Math.random() * pool.length)];
    } catch {
      return null;
    }
  }
}
