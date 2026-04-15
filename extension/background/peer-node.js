/**
 * PeerNode - Proxy class that delegates WebRTC to an offscreen document.
 * Chrome MV3 service workers cannot use RTCPeerConnection directly,
 * so all WebRTC runs in offscreen/offscreen.html and this class
 * communicates with it via chrome.runtime messaging.
 */

export class PeerNode {
  constructor(signalingUrl) {
    this.signalingUrl = signalingUrl;
    this.running = false;
  }

  async _ensureOffscreen() {
    const existing = await chrome.offscreen.hasDocument();
    if (!existing) {
      await chrome.offscreen.createDocument({
        url: "offscreen/offscreen.html",
        reasons: ["WEB_RTC"],
        justification: "WebRTC peer connections for P2P proxy relay",
      });
    }
  }

  async start(bwLimitMbps) {
    if (this.running) await this.stop();
    this.running = true;
    await this._ensureOffscreen();
    await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "peer:start",
      signalingUrl: this.signalingUrl,
      bwLimit: bwLimitMbps,
    });
  }

  async stop() {
    this.running = false;
    try {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "peer:stop",
      });
    } catch {
      // offscreen may already be closed
    }
  }

  setBandwidthLimit(mbps) {
    chrome.runtime.sendMessage({
      target: "offscreen",
      type: "peer:setBwLimit",
      value: mbps,
    }).catch(() => {});
  }

  getPeerCount() {
    return this._peerCount || 0;
  }

  getDataRelayed() {
    return this._dataRelayed || 0;
  }

  // Called periodically to sync stats from offscreen
  async heartbeat() {
    try {
      await this._ensureOffscreen();
      const stats = await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "peer:getStats",
      });
      if (stats) {
        this._peerCount = stats.peerCount || 0;
        this._dataRelayed = stats.dataRelayed || 0;
      }
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "peer:heartbeat",
      });
    } catch {
      // offscreen not available
    }
  }
}
