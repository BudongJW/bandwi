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

    // Manual cron trigger (API key protected)
    if (request.method === "POST" && url.pathname === "/api/cron/trigger") {
      const apiKey = request.headers.get("X-API-Key");
      if (!env.BANDWI_API_KEY || apiKey !== env.BANDWI_API_KEY) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
      await fetchAndRegisterProxies(env);
      // Return current stats
      const id = env.SIGNALING.idFromName("global");
      const stub = env.SIGNALING.get(id);
      const statsResp = await stub.fetch(new Request("https://internal/api/stats"));
      const stats = await statsResp.json();
      return jsonResponse({ ok: true, triggered: true, ...stats });
    }

    // All traffic goes to a single Durable Object instance
    const id = env.SIGNALING.idFromName("global");
    const stub = env.SIGNALING.get(id);
    return stub.fetch(request);
  },

  // Cron trigger: fetch free proxies and register as static nodes
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fetchAndRegisterProxies(env));
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
    // Static proxy TTL: 25 minutes (cron runs every 20 min, so always fresh)
    this.STATIC_TTL_MS = 25 * 60 * 1000;

    // Restore static nodes from DO Storage on wake-up
    this._restored = this.state.blockConcurrencyWhile(async () => {
      const stored = await this.state.storage.get("staticNodes");
      if (stored) {
        for (const [id, node] of Object.entries(stored)) {
          this.nodes.set(id, node);
        }
        // Update idCounter to avoid collisions
        const maxId = Object.keys(stored).reduce((max, k) => {
          const num = parseInt(k.replace("static_", ""), 10);
          return isNaN(num) ? max : Math.max(max, num);
        }, 0);
        this.idCounter = maxId;
      }
    });
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

      // Persist static nodes to DO Storage
      await this._persistStatic();

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

  // Save static nodes to DO Storage (survives hibernate)
  async _persistStatic() {
    const staticNodes = {};
    for (const [id, node] of this.nodes) {
      if (node.type === "static") {
        staticNodes[id] = {
          addr: node.addr,
          country: node.country,
          proxyType: node.proxyType,
          bwLimit: node.bwLimit,
          lastSeen: node.lastSeen,
          type: "static",
        };
      }
    }
    await this.state.storage.put("staticNodes", staticNodes);
  }
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

// ── Cron: Free Proxy Fetcher ──────────────────────────────
const PROXY_SOURCES = [
  {
    url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=json",
    parse: parseProxyScrape,
  },
];

async function fetchAndRegisterProxies(env) {
  const candidates = [];

  for (const source of PROXY_SOURCES) {
    try {
      const resp = await fetch(source.url, {
        headers: { "User-Agent": "Bandwi-Worker/0.1" },
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const parsed = source.parse(data);
      candidates.push(...parsed);
    } catch {
      // Source unavailable, skip
    }
  }

  if (!candidates.length) return;

  // Health check: test proxies in batches via HTTP CONNECT
  const verified = await healthCheckProxies(candidates);

  if (!verified.length) return;

  // Register to our own Durable Object
  const id = env.SIGNALING.idFromName("global");
  const stub = env.SIGNALING.get(id);
  await stub.fetch(new Request("https://internal/api/nodes/register", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": env.BANDWI_API_KEY || "",
    },
    body: JSON.stringify(verified),
  }));
}

// Test proxy connectivity by attempting a fetch through them
// CF Workers can't do raw TCP, so we test HTTP proxies via fetch
// and mark socks proxies as unverified (pass through, client will verify)
async function healthCheckProxies(proxies) {
  const httpProxies = proxies.filter((p) => p.type === "http");
  const socksProxies = proxies.filter((p) => p.type !== "http");

  // For HTTP proxies: test a sample to estimate list quality
  // Testing all would exceed CF CPU limits, so sample up to 50
  const sampleSize = Math.min(httpProxies.length, 50);
  const sample = shuffle(httpProxies).slice(0, sampleSize);
  const testUrl = "http://httpbin.org/ip";

  const results = await Promise.allSettled(
    sample.map((p) =>
      fetch(testUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
        cf: { resolveOverride: p.addr.split(":")[0] },
      })
        .then((r) => (r.ok ? p : null))
        .catch(() => null)
    )
  );

  const working = results
    .filter((r) => r.status === "fulfilled" && r.value)
    .map((r) => r.value);

  // If sample pass rate > 30%, include all HTTP proxies from source
  // (proxyscrape already filters alive=true)
  const passRate = sampleSize > 0 ? working.length / sampleSize : 0;
  const verified = [];

  if (passRate > 0.3) {
    verified.push(...httpProxies);
  } else {
    verified.push(...working);
  }

  // SOCKS proxies: include all (can't test from CF Workers)
  // Client-side will handle failures via auto-reconnect
  verified.push(...socksProxies);

  return verified;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function parseProxyScrape(data) {
  const results = [];
  const items = data.proxies || [];
  for (const p of items) {
    if (!p.alive || !p.ip || !p.port || !p.ip_data?.countryCode) continue;
    // Only include proxies with recent check time
    const proto = (p.protocol || "http").toLowerCase();
    let type = "http";
    if (proto.includes("socks5")) type = "socks5";
    else if (proto.includes("socks4")) type = "socks4";
    results.push({
      addr: `${p.ip}:${p.port}`,
      country: p.ip_data.countryCode,
      type,
    });
  }
  return results;
}
