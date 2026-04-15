/**
 * Bandwi Signaling Server - Cloudflare Workers + Durable Objects
 *
 * Single Durable Object instance manages all WebSocket connections,
 * node registry, and WebRTC signaling relay.
 *
 * Free tier: 100k req/day Workers, Durable Objects $0.15/M requests
 */

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    // All traffic goes to a single Durable Object instance
    const id = env.SIGNALING.idFromName("global");
    const stub = env.SIGNALING.get(id);
    return stub.fetch(request);
  },
};

// API key loaded from CF Workers secret (wrangler secret put BANDWI_API_KEY)
// Passed to Durable Object via env binding

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-API-Key",
  };
}

// ── Durable Object: SignalingDO ────────────────────────────
export class SignalingDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    // nodeId -> { ws, addr, country, bwLimit, lastSeen, type }
    //   type: "p2p" (WebSocket-connected) | "static" (registered via API)
    this.nodes = new Map();
    // clientId -> { ws, connectedNode }
    this.clients = new Map();
    this.idCounter = 0;
    // Static proxy TTL: 30 minutes
    this.STATIC_TTL_MS = 30 * 60 * 1000;
  }

  nextId() {
    return `peer_${++this.idCounter}`;
  }

  async fetch(request) {
    const url = new URL(request.url);

    // ── REST API ─────────────────────────────────────────────
    if (request.method === "GET" && url.pathname === "/api/stats") {
      return jsonResponse({
        nodes: this.nodes.size,
        clients: this.clients.size,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/nodes") {
      this._cleanExpiredStatic();
      const country = url.searchParams.get("country");
      const result = [];
      for (const [id, node] of this.nodes) {
        if (!country || node.country === country) {
          result.push({
            id,
            addr: node.addr,
            country: node.country,
            bwLimit: node.bwLimit,
            type: node.type || "p2p",
            proxyType: node.proxyType || null,
          });
        }
      }
      return jsonResponse(result);
    }

    // ── Static Proxy Registration (from gaechoo pipeline) ─────
    if (request.method === "POST" && url.pathname === "/api/nodes/register") {
      const apiKey = request.headers.get("X-API-Key");
      if (!this.env.BANDWI_API_KEY || apiKey !== this.env.BANDWI_API_KEY) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: "invalid json" }, 400);
      }

      const proxies = Array.isArray(body) ? body : body.proxies || [];
      if (!proxies.length) {
        return jsonResponse({ error: "empty proxy list" }, 400);
      }

      // Clean expired static nodes first
      this._cleanExpiredStatic();

      let added = 0;
      const byCountry = {};
      for (const p of proxies) {
        if (!p.addr || !p.country) continue;
        // Deduplicate by addr
        const existing = [...this.nodes.values()].find(
          (n) => n.addr === p.addr
        );
        if (existing) {
          existing.lastSeen = Date.now();
          continue;
        }

        const nodeId = `static_${++this.idCounter}`;
        this.nodes.set(nodeId, {
          ws: null,
          addr: p.addr,
          country: p.country.toUpperCase(),
          proxyType: p.type || "http", // http, socks5, socks4
          bwLimit: 0,
          lastSeen: Date.now(),
          type: "static",
        });
        added++;
        byCountry[p.country] = (byCountry[p.country] || 0) + 1;
      }

      return jsonResponse({
        ok: true,
        added,
        total: this.nodes.size,
        byCountry,
      });
    }

    // ── WebSocket Upgrade (must check before catch-all routes) ─
    const upgrade = request.headers.get("Upgrade");
    if (upgrade && upgrade.toLowerCase() === "websocket") {
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);

      const peerId = this.nextId();
      const ip =
        request.headers.get("CF-Connecting-IP") ||
        request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
        "unknown";
      const cfCountry = request.headers.get("CF-IPCountry") || null;

      server.accept();

      server.addEventListener("message", (event) => {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }
        this.handleMessage(peerId, server, ip, cfCountry, msg);
      });

      server.addEventListener("close", () => {
        this.nodes.delete(peerId);
        this.clients.delete(peerId);
      });

      server.addEventListener("error", () => {
        this.nodes.delete(peerId);
        this.clients.delete(peerId);
      });

      return new Response(null, { status: 101, webSocket: client });
    }

    // ── Catch-all info route ───────────────────────────────────
    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse({
        service: "Bandwi Signaling",
        version: "0.1.0",
        nodes: this.nodes.size,
        clients: this.clients.size,
      });
    }

    return jsonResponse({ error: "not found" }, 404);
  }

  handleMessage(peerId, ws, ip, cfCountry, msg) {
    switch (msg.type) {
      // ── Registration ─────────────────────────────────────────
      case "register":
        if (msg.role === "node") {
          this.nodes.set(peerId, {
            ws,
            addr: `${ip}:0`,
            country: cfCountry || msg.country || "XX",
            bwLimit: msg.bwLimit || 10,
            lastSeen: Date.now(),
          });
          ws.send(JSON.stringify({ type: "registered", peerId }));
        } else {
          this.clients.set(peerId, { ws, connectedNode: null });
          ws.send(JSON.stringify({ type: "registered", peerId }));
        }
        break;

      // ── WebRTC Signaling Relay ───────────────────────────────
      case "offer": {
        const targetNode = this.nodes.get(msg.targetNodeId);
        if (targetNode && isOpen(targetNode.ws)) {
          targetNode.ws.send(
            JSON.stringify({ type: "offer", peerId, offer: msg.offer })
          );
        }
        break;
      }

      case "answer": {
        const targetClient = this.clients.get(msg.peerId);
        if (targetClient && isOpen(targetClient.ws)) {
          targetClient.ws.send(
            JSON.stringify({ type: "answer", peerId, answer: msg.answer })
          );
        }
        break;
      }

      case "ice-candidate": {
        const target =
          this.nodes.get(msg.peerId)?.ws || this.clients.get(msg.peerId)?.ws;
        if (target && isOpen(target)) {
          target.send(
            JSON.stringify({
              type: "ice-candidate",
              peerId,
              candidate: msg.candidate,
            })
          );
        }
        break;
      }

      case "heartbeat": {
        const node = this.nodes.get(peerId);
        if (node) node.lastSeen = Date.now();
        break;
      }
    }
  }

  // Clean expired static proxy nodes (TTL-based)
  _cleanExpiredStatic() {
    const now = Date.now();
    for (const [id, node] of this.nodes) {
      if (node.type === "static" && now - node.lastSeen > this.STATIC_TTL_MS) {
        this.nodes.delete(id);
      }
    }
  }

  // Durable Objects auto-hibernate when no connections remain.
  // P2P nodes cleaned on WebSocket close; static nodes cleaned on TTL.
}

// ── Helpers ────────────────────────────────────────────────
function isOpen(ws) {
  return ws.readyState === 1; // WebSocket.OPEN
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
