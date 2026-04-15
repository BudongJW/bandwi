/**
 * ProxyManager - Manages chrome.proxy API for VPN mode.
 *
 * Two-phase PAC strategy:
 *   Phase 1 (verify): strict PAC, NO DIRECT fallback.
 *     Verification fetch goes through proxy — confirms it actually works.
 *   Phase 2 (active):  resilient PAC, WITH DIRECT fallback.
 *     If proxy dies mid-session, internet still works (IP may leak).
 */

const MAX_CONNECT_ATTEMPTS = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2000;
const VERIFY_TIMEOUT_MS = 8000;
const SIGNALING_HOST = "bandwi-signaling.dlawodnjs.workers.dev";

export class ProxyManager {
  constructor() {
    this.currentProxy = null;
    this.currentCountry = null;
    this.failedAddrs = new Set();
    this.retryCount = 0;
    this._reconnecting = false;
    this._connectionSeq = 0;
    this._myIp = null;

    chrome.proxy.onProxyError.addListener((details) => {
      console.warn(`[Bandwi] Proxy error: ${details.error}`);
      if (this.currentCountry && !this._reconnecting) {
        this._autoReconnect();
      }
    });
  }

  async restore() {
    const stored = await chrome.storage.local.get([
      "vpnStatus",
      "vpnCountry",
      "vpnProxy",
    ]);

    if (stored.vpnStatus === "connecting") {
      await this._forceClearProxy();
      await chrome.storage.local.set({ vpnStatus: "disconnected" });
      await chrome.storage.local.remove(["vpnConnected", "vpnCountry", "vpnProxy"]);
      return false;
    }

    if (stored.vpnStatus === "connected" && stored.vpnCountry && stored.vpnProxy) {
      this.currentCountry = stored.vpnCountry;
      this.currentProxy = stored.vpnProxy;
      await this._applyPac(stored.vpnProxy, true);
      return true;
    }

    if (!stored.vpnStatus || stored.vpnStatus === "disconnected") {
      await this._forceClearProxy();
    }
    return false;
  }

  async connect(country) {
    this.currentCountry = country;
    this.failedAddrs.clear();
    this.retryCount = 0;
    const seq = ++this._connectionSeq;

    // Get my real IP first (before any proxy is set)
    await this._detectMyIp();

    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      if (this._connectionSeq !== seq) return false;

      const node = await this._findNode(country);
      if (!node) {
        console.warn(`[Bandwi] No more nodes in ${country}`);
        break;
      }

      const ok = await this._applyAndVerify(node);
      if (this._connectionSeq !== seq) return false;

      if (ok) return true;

      this.failedAddrs.add(node.addr);
      await this._forceClearProxy();
      console.log(
        `[Bandwi] Node ${node.addr} failed (${i + 1}/${MAX_CONNECT_ATTEMPTS})`
      );
    }

    await this._forceClearProxy();
    return false;
  }

  // Build PAC script
  // strict=false: add DIRECT fallback (for active use)
  // strict=true:  no fallback (for verification — must go through proxy)
  _buildPac(node, strict) {
    const pType = node.proxyType || "socks5";
    let directive;
    if (pType === "http" || pType === "https") {
      directive = `PROXY ${node.addr}`;
    } else if (pType === "socks4") {
      directive = `SOCKS ${node.addr}`;
    } else {
      directive = `SOCKS5 ${node.addr}`;
    }

    const fallback = strict ? "" : "; DIRECT";

    return {
      mode: "pac_script",
      pacScript: {
        data: `function FindProxyForURL(url, host) {
          if (isPlainHostName(host) || host === "localhost") return "DIRECT";
          if (host === "${SIGNALING_HOST}") return "DIRECT";
          return "${directive}${fallback}";
        }`,
      },
    };
  }

  async _applyPac(node, withFallback) {
    const config = this._buildPac(node, !withFallback);
    await chrome.proxy.settings.set({ value: config, scope: "regular" });
  }

  async _applyAndVerify(node) {
    this.currentProxy = node;
    const pType = node.proxyType || "socks5";

    // Phase 1: strict PAC (no DIRECT fallback) — verify through proxy
    await this._applyPac(node, false);

    const exitInfo = await this._verifyConnectivity();
    if (!exitInfo) return false;

    // Check that exit IP is different from our real IP
    if (this._myIp && exitInfo.ip === this._myIp) {
      console.warn(`[Bandwi] Proxy ${node.addr} leaks real IP, skipping`);
      return false;
    }

    // Phase 2: switch to resilient PAC (with DIRECT fallback)
    await this._applyPac(node, true);

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
      `[Bandwi] VPN connected via ${node.addr}, exit: ${exitInfo.ip} (${exitInfo.countryCode})`
    );
    return true;
  }

  async _detectMyIp() {
    try {
      const resp = await fetch("http://ip-api.com/json/?fields=query", {
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      this._myIp = data.query || null;
      console.log(`[Bandwi] My real IP: ${this._myIp}`);
    } catch {
      this._myIp = null;
    }
  }

  // Verification: fetch IP check through the proxy (strict PAC active)
  async _verifyConnectivity() {
    try {
      const resp = await fetch(
        "http://ip-api.com/json/?fields=query,countryCode",
        { signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) }
      );
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.query) return null;
      console.log(`[Bandwi] Verify exit: ${data.query} (${data.countryCode})`);
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
      }
      return;
    }

    this._reconnecting = true;
    this.retryCount++;

    if (this.currentProxy) {
      this.failedAddrs.add(this.currentProxy.addr || this.currentProxy);
    }

    await this._forceClearProxy();

    console.log(
      `[Bandwi] Auto-reconnect ${this.retryCount}/${MAX_RETRIES}`
    );

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

    const node = await this._findNode(this.currentCountry);
    if (node) {
      const ok = await this._applyAndVerify(node);
      if (ok) {
        this.retryCount = 0;
        this._reconnecting = false;
        return;
      }
    }

    this._reconnecting = false;
    if (this.retryCount < MAX_RETRIES) {
      this._autoReconnect();
    } else {
      await this.disconnect();
    }
  }

  async disconnect() {
    this._connectionSeq++;
    await this._forceClearProxy();

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

  async _forceClearProxy() {
    try {
      await chrome.proxy.settings.set({
        value: { mode: "direct" },
        scope: "regular",
      });
    } catch {}
    await chrome.proxy.settings.clear({ scope: "regular" });
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

      // Prefer SOCKS5 > SOCKS4 (skip HTTP — breaks HTTPS)
      const socks5 = available.filter((n) => (n.proxyType || n.type) === "socks5");
      const socks4 = available.filter((n) => (n.proxyType || n.type) === "socks4");
      const pool = socks5.length ? socks5 : socks4.length ? socks4 : available;

      return pool[Math.floor(Math.random() * pool.length)];
    } catch {
      return null;
    }
  }
}
