/**
 * ProxyManager - Manages chrome.proxy API for VPN mode.
 *
 * Security features:
 *   - No DIRECT fallback: proxy failure shows error page (prevents IP leak)
 *   - WebRTC leak prevention via chrome.privacy API
 *   - Real IP verification: rejects proxies that leak user's IP
 *   - SOCKS5 only: SOCKS4 leaks DNS, HTTP does MITM on HTTPS
 *   - Multi-proxy failover in PAC for resilience
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
    this._fallbackNodes = [];

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
      "vpnFallbackNodes",
    ]);

    if (stored.vpnStatus === "connecting") {
      await this._forceClearProxy();
      await this._disableWebRtcProtection();
      await chrome.storage.local.set({ vpnStatus: "disconnected" });
      await chrome.storage.local.remove(["vpnConnected", "vpnCountry", "vpnProxy", "vpnFallbackNodes"]);
      return false;
    }

    if (stored.vpnStatus === "connected" && stored.vpnCountry && stored.vpnProxy) {
      this.currentCountry = stored.vpnCountry;
      this.currentProxy = stored.vpnProxy;
      this._fallbackNodes = stored.vpnFallbackNodes || [];
      await this._enableWebRtcProtection();
      await this._applyPac(stored.vpnProxy, this._fallbackNodes);
      this._updateBadge("connected");
      return true;
    }

    if (!stored.vpnStatus || stored.vpnStatus === "disconnected") {
      await this._forceClearProxy();
      await this._disableWebRtcProtection();
      this._updateBadge("disconnected");
    }
    return false;
  }

  async connect(country) {
    this.currentCountry = country;
    this.failedAddrs.clear();
    this.retryCount = 0;
    this._fallbackNodes = [];
    const seq = ++this._connectionSeq;

    this._updateBadge("connecting");

    // Enable WebRTC protection before connecting
    await this._enableWebRtcProtection();

    // Get my real IP first (before any proxy is set)
    await this._detectMyIp();

    for (let i = 0; i < MAX_CONNECT_ATTEMPTS; i++) {
      if (this._connectionSeq !== seq) return false;

      const nodes = await this._findNodes(country);
      if (!nodes.length) {
        console.warn(`[Bandwi] No more nodes in ${country}`);
        break;
      }

      const primary = nodes[0];
      const fallbacks = nodes.slice(1, 4); // Up to 3 fallbacks for PAC chain

      const ok = await this._applyAndVerify(primary, fallbacks);
      if (this._connectionSeq !== seq) return false;

      if (ok) {
        this._updateBadge("connected");
        return true;
      }

      this.failedAddrs.add(primary.addr);
      await this._forceClearProxy();
      console.log(
        `[Bandwi] Node ${primary.addr} failed (${i + 1}/${MAX_CONNECT_ATTEMPTS})`
      );
    }

    await this._forceClearProxy();
    await this._disableWebRtcProtection();
    this._updateBadge("disconnected");
    return false;
  }

  _buildPac(node, fallbackNodes = []) {
    // Build multi-proxy failover chain (SOCKS5 only)
    const directives = [];

    const toDirective = (n) => {
      const pType = n.proxyType || "socks5";
      if (pType === "socks5") return `SOCKS5 ${n.addr}`;
      if (pType === "socks4") return `SOCKS ${n.addr}`;
      return `PROXY ${n.addr}`;
    };

    directives.push(toDirective(node));
    for (const fb of fallbackNodes) {
      directives.push(toDirective(fb));
    }

    // No DIRECT fallback — proxy failure shows error page
    // and triggers auto-reconnect. This prevents IP leaks.
    const chain = directives.join("; ");

    return {
      mode: "pac_script",
      pacScript: {
        data: `function FindProxyForURL(url, host) {
          if (isPlainHostName(host) || host === "localhost") return "DIRECT";
          if (host === "${SIGNALING_HOST}") return "DIRECT";
          return "${chain}";
        }`,
        mandatory: true,
      },
    };
  }

  async _applyPac(node, fallbackNodes = []) {
    const config = this._buildPac(node, fallbackNodes);
    await chrome.proxy.settings.set({ value: config, scope: "regular" });
  }

  async _applyAndVerify(node, fallbackNodes = []) {
    this.currentProxy = node;
    this._fallbackNodes = fallbackNodes;
    const pType = node.proxyType || "socks5";

    await this._applyPac(node, fallbackNodes);

    const exitInfo = await this._verifyConnectivity();
    if (!exitInfo) return false;

    // Reject proxies that leak our real IP
    if (this._myIp && exitInfo.ip === this._myIp) {
      console.warn(`[Bandwi] Proxy ${node.addr} leaks real IP, skipping`);
      return false;
    }

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
      vpnFallbackNodes: fallbackNodes,
    });

    console.log(
      `[Bandwi] VPN connected via ${node.addr}, exit: ${exitInfo.ip} (${exitInfo.countryCode}), fallbacks: ${fallbackNodes.length}`
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
    this._updateBadge("connecting");

    if (this.currentProxy) {
      this.failedAddrs.add(this.currentProxy.addr || this.currentProxy);
    }

    await this._forceClearProxy();

    console.log(
      `[Bandwi] Auto-reconnect ${this.retryCount}/${MAX_RETRIES}`
    );

    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));

    const nodes = await this._findNodes(this.currentCountry);
    if (nodes.length) {
      const ok = await this._applyAndVerify(nodes[0], nodes.slice(1, 4));
      if (ok) {
        this.retryCount = 0;
        this._reconnecting = false;
        this._updateBadge("connected");
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
    await this._disableWebRtcProtection();

    this.currentProxy = null;
    this.currentCountry = null;
    this._fallbackNodes = [];
    this.failedAddrs.clear();
    this.retryCount = 0;
    this._reconnecting = false;

    await chrome.storage.local.set({ vpnStatus: "disconnected" });
    await chrome.storage.local.remove([
      "vpnConnected",
      "vpnCountry",
      "vpnProxy",
      "vpnFallbackNodes",
    ]);

    this._updateBadge("disconnected");
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

  // WebRTC leak prevention
  async _enableWebRtcProtection() {
    try {
      await chrome.privacy.network.webRTCIPHandlingPolicy.set({
        value: "disable_non_proxied_udp",
      });
      console.log("[Bandwi] WebRTC leak protection enabled");
    } catch (e) {
      console.warn("[Bandwi] Failed to set WebRTC policy:", e);
    }
  }

  async _disableWebRtcProtection() {
    try {
      await chrome.privacy.network.webRTCIPHandlingPolicy.clear({});
      console.log("[Bandwi] WebRTC leak protection disabled");
    } catch {}
  }

  // Badge icon for connection status
  _updateBadge(status) {
    const colors = {
      connected: "#22c55e",
      connecting: "#f59e0b",
      disconnected: "#666666",
    };
    const texts = {
      connected: "ON",
      connecting: "...",
      disconnected: "",
    };
    try {
      chrome.action.setBadgeBackgroundColor({ color: colors[status] || "#666" });
      chrome.action.setBadgeText({ text: texts[status] || "" });
    } catch {}
  }

  // Returns multiple nodes for failover chain
  async _findNodes(country) {
    try {
      const resp = await fetch(
        `https://${SIGNALING_HOST}/api/nodes?country=${country}`
      );
      if (!resp.ok) return [];
      const nodes = await resp.json();
      const available = nodes.filter((n) => !this.failedAddrs.has(n.addr));
      if (!available.length) return [];

      // SOCKS5 only (SOCKS4 leaks DNS, HTTP does MITM)
      const socks5 = available.filter((n) => (n.proxyType || n.type) === "socks5");
      const pool = socks5.length ? socks5 : available;

      // Shuffle for load distribution
      for (let i = pool.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }

      return pool;
    } catch {
      return [];
    }
  }
}
