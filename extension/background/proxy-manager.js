/**
 * ProxyManager - Manages chrome.proxy API for VPN mode.
 * Connects to a peer node in the selected country via
 * the signaling server, then routes all browser traffic
 * through that peer using PAC script.
 */

export class ProxyManager {
  constructor() {
    this.currentProxy = null;
    this.peerConnection = null;
  }

  async connect(country) {
    // TODO: Query signaling server for available node in target country
    // For now, use a placeholder that demonstrates the chrome.proxy API flow
    const node = await this._findNode(country);
    if (!node) {
      console.warn(`[Bandwi] No available node in ${country}`);
      return;
    }

    this.currentProxy = node;

    // Set PAC script to route traffic through the proxy node
    const config = {
      mode: "pac_script",
      pacScript: {
        data: `function FindProxyForURL(url, host) {
          if (isPlainHostName(host) || host === "localhost") {
            return "DIRECT";
          }
          return "SOCKS5 ${node.addr}; DIRECT";
        }`,
      },
    };

    await chrome.proxy.settings.set({ value: config, scope: "regular" });
    console.log(`[Bandwi] VPN connected via ${node.addr} (${country})`);
  }

  async disconnect() {
    // Restore direct connection
    await chrome.proxy.settings.clear({ scope: "regular" });
    this.currentProxy = null;

    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    console.log("[Bandwi] VPN disconnected");
  }

  async _findNode(country) {
    // TODO: Implement signaling server query
    // POST /api/nodes?country=XX -> { addr, peerId, country, bwLimit }
    try {
      const resp = await fetch(
        `https://bandwi-signaling.dlawodnjs.workers.dev/api/nodes?country=${country}`
      );
      if (!resp.ok) return null;
      const nodes = await resp.json();
      if (!nodes.length) return null;
      // Pick random node for load distribution
      return nodes[Math.floor(Math.random() * nodes.length)];
    } catch {
      return null;
    }
  }
}
