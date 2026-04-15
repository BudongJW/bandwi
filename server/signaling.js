/**
 * Bandwi Signaling Server
 * Handles WebRTC signaling between VPN clients and proxy nodes.
 * Also serves as a node registry and API endpoint.
 */

import { WebSocketServer } from "ws";
import http from "http";
import { URL } from "url";

const PORT = Number(process.env.PORT) || 8787;

// ── Node Registry ──────────────────────────────────────────
const nodes = new Map(); // nodeId -> { ws, addr, country, bwLimit, lastSeen }
const clients = new Map(); // clientId -> { ws, connectedNode }

let idCounter = 0;
function nextId() {
  return `peer_${++idCounter}`;
}

// ── HTTP Server (REST API) ─────────────────────────────────
const httpServer = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (req.method === "GET" && url.pathname === "/api/nodes") {
    const country = url.searchParams.get("country");
    const result = [];
    for (const [id, node] of nodes) {
      if (!country || node.country === country) {
        result.push({
          id,
          addr: node.addr,
          country: node.country,
          bwLimit: node.bwLimit,
        });
      }
    }
    res.writeHead(200);
    res.end(JSON.stringify(result));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/stats") {
    res.writeHead(200);
    res.end(
      JSON.stringify({
        nodes: nodes.size,
        clients: clients.size,
      })
    );
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: "not found" }));
});

// ── WebSocket Server (Signaling) ───────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  const peerId = nextId();
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress;

  console.log(`[+] ${peerId} connected from ${ip}`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    switch (msg.type) {
      // ── Node registration ──────────────────────────────────
      case "register":
        if (msg.role === "node") {
          nodes.set(peerId, {
            ws,
            addr: `${ip}:0`, // real addr determined after STUN
            country: msg.country || detectCountry(ip),
            bwLimit: msg.bwLimit || 10,
            lastSeen: Date.now(),
          });
          ws.send(JSON.stringify({ type: "registered", peerId }));
          console.log(`[node] ${peerId} registered (${ip})`);
        } else {
          clients.set(peerId, { ws, connectedNode: null });
          ws.send(JSON.stringify({ type: "registered", peerId }));
          console.log(`[client] ${peerId} registered`);
        }
        break;

      // ── WebRTC signaling relay ─────────────────────────────
      case "offer": {
        const targetNode = nodes.get(msg.targetNodeId);
        if (targetNode?.ws.readyState === 1) {
          targetNode.ws.send(
            JSON.stringify({
              type: "offer",
              peerId,
              offer: msg.offer,
            })
          );
        }
        break;
      }

      case "answer": {
        const targetClient = clients.get(msg.peerId);
        if (targetClient?.ws.readyState === 1) {
          targetClient.ws.send(
            JSON.stringify({
              type: "answer",
              peerId,
              answer: msg.answer,
            })
          );
        }
        break;
      }

      case "ice-candidate": {
        // Relay ICE candidates bidirectionally
        const target =
          nodes.get(msg.peerId)?.ws || clients.get(msg.peerId)?.ws;
        if (target?.readyState === 1) {
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
        const node = nodes.get(peerId);
        if (node) node.lastSeen = Date.now();
        break;
      }
    }
  });

  ws.on("close", () => {
    nodes.delete(peerId);
    clients.delete(peerId);
    console.log(`[-] ${peerId} disconnected`);
  });
});

// ── Country Detection (placeholder) ────────────────────────
function detectCountry(_ip) {
  // TODO: Use ip-api.com or MaxMind GeoIP
  return "KR";
}

// ── Stale Node Cleanup ─────────────────────────────────────
setInterval(() => {
  const now = Date.now();
  for (const [id, node] of nodes) {
    if (now - node.lastSeen > 5 * 60 * 1000) {
      node.ws.close();
      nodes.delete(id);
      console.log(`[cleanup] ${id} removed (stale)`);
    }
  }
}, 60 * 1000);

// ── Start ──────────────────────────────────────────────────
httpServer.listen(PORT, () => {
  console.log(`Bandwi signaling server running on :${PORT}`);
});
