/**
 * PeerNode - WebRTC-based P2P proxy node.
 * Accepts incoming peer connections and relays HTTP traffic
 * through the local network, acting as a residential proxy.
 */

export class PeerNode {
  constructor(signalingUrl) {
    this.signalingUrl = signalingUrl;
    this.ws = null;
    this.peers = new Map(); // peerId -> RTCPeerConnection
    this.dataChannels = new Map(); // peerId -> RTCDataChannel
    this.bwLimitMbps = 10;
    this.dataRelayed = 0;
    this.running = false;
  }

  async start(bwLimitMbps) {
    this.bwLimitMbps = bwLimitMbps;
    this.running = true;
    this._connectSignaling();
  }

  async stop() {
    this.running = false;
    for (const [id, pc] of this.peers) {
      pc.close();
    }
    this.peers.clear();
    this.dataChannels.clear();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  setBandwidthLimit(mbps) {
    this.bwLimitMbps = mbps;
  }

  getPeerCount() {
    return this.peers.size;
  }

  getDataRelayed() {
    return this.dataRelayed;
  }

  heartbeat() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "heartbeat" }));
    }
  }

  // ── Signaling ──────────────────────────────────────────────
  _connectSignaling() {
    if (!this.running) return;

    try {
      this.ws = new WebSocket(this.signalingUrl);
    } catch {
      setTimeout(() => this._connectSignaling(), 5000);
      return;
    }

    this.ws.onopen = () => {
      this.ws.send(
        JSON.stringify({
          type: "register",
          role: "node",
          bwLimit: this.bwLimitMbps,
        })
      );
    };

    this.ws.onmessage = async (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case "offer":
          await this._handleOffer(msg);
          break;
        case "ice-candidate":
          await this._handleIceCandidate(msg);
          break;
      }
    };

    this.ws.onclose = () => {
      if (this.running) {
        setTimeout(() => this._connectSignaling(), 5000);
      }
    };
  }

  // ── WebRTC ─────────────────────────────────────────────────
  async _handleOffer(msg) {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });

    this.peers.set(msg.peerId, pc);

    pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            type: "ice-candidate",
            peerId: msg.peerId,
            candidate: e.candidate,
          })
        );
      }
    };

    pc.ondatachannel = (e) => {
      const dc = e.channel;
      this.dataChannels.set(msg.peerId, dc);

      dc.onmessage = (event) => {
        this._handleProxyRequest(msg.peerId, event.data);
      };

      dc.onclose = () => {
        this.dataChannels.delete(msg.peerId);
        pc.close();
        this.peers.delete(msg.peerId);
      };
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.dataChannels.delete(msg.peerId);
        pc.close();
        this.peers.delete(msg.peerId);
      }
    };

    await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.ws.send(
      JSON.stringify({
        type: "answer",
        peerId: msg.peerId,
        answer: pc.localDescription,
      })
    );
  }

  async _handleIceCandidate(msg) {
    const pc = this.peers.get(msg.peerId);
    if (pc) {
      await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
    }
  }

  // ── Proxy Request Handler ──────────────────────────────────
  async _handleProxyRequest(peerId, rawData) {
    const dc = this.dataChannels.get(peerId);
    if (!dc) return;

    try {
      const request = JSON.parse(rawData);

      // Traffic filtering: block private IPs, dangerous ports
      if (this._isBlocked(request.url)) {
        dc.send(JSON.stringify({ error: "blocked", code: 403 }));
        return;
      }

      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers: request.headers || {},
        body: request.body || null,
      });

      const body = await response.text();
      this.dataRelayed += new Blob([body]).size;

      dc.send(
        JSON.stringify({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          body,
        })
      );
    } catch (err) {
      dc.send(JSON.stringify({ error: err.message, code: 502 }));
    }
  }

  _isBlocked(url) {
    try {
      const u = new URL(url);
      const host = u.hostname;
      // Block private/local networks
      if (
        host === "localhost" ||
        host.startsWith("127.") ||
        host.startsWith("10.") ||
        host.startsWith("192.168.") ||
        host.match(/^172\.(1[6-9]|2\d|3[01])\./)
      ) {
        return true;
      }
      // Block dangerous ports
      const blockedPorts = [22, 23, 25, 445, 3389];
      if (u.port && blockedPorts.includes(Number(u.port))) {
        return true;
      }
      return false;
    } catch {
      return true;
    }
  }
}
