/**
 * Offscreen document for WebRTC P2P proxy node.
 * Chrome MV3 service workers cannot use RTCPeerConnection,
 * so all WebRTC logic runs here and communicates with the
 * service worker via chrome.runtime messaging.
 */

let ws = null;
let signalingUrl = "";
let bwLimitMbps = 10;
let running = false;
const peers = new Map();
const dataChannels = new Map();
let dataRelayed = 0;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg.target) {
    case "offscreen":
      break;
    default:
      return;
  }

  switch (msg.type) {
    case "peer:start":
      signalingUrl = msg.signalingUrl;
      bwLimitMbps = msg.bwLimit || 10;
      running = true;
      connectSignaling();
      sendResponse({ ok: true });
      break;

    case "peer:stop":
      running = false;
      for (const [id, pc] of peers) {
        pc.close();
      }
      peers.clear();
      dataChannels.clear();
      if (ws) {
        ws.close();
        ws = null;
      }
      sendResponse({ ok: true });
      break;

    case "peer:heartbeat":
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "heartbeat" }));
      }
      sendResponse({ ok: true });
      break;

    case "peer:setBwLimit":
      bwLimitMbps = msg.value;
      sendResponse({ ok: true });
      break;

    case "peer:getStats":
      sendResponse({
        peerCount: peers.size,
        dataRelayed,
      });
      break;
  }
  return true;
});

function connectSignaling() {
  if (!running) return;

  // Close existing connection before creating new one
  if (ws) {
    try { ws.close(); } catch {}
    ws = null;
  }

  try {
    ws = new WebSocket(signalingUrl);
  } catch {
    setTimeout(() => connectSignaling(), 5000);
    return;
  }

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: "register",
        role: "node",
        bwLimit: bwLimitMbps,
      })
    );
  };

  ws.onmessage = async (event) => {
    const msg = JSON.parse(event.data);
    switch (msg.type) {
      case "offer":
        await handleOffer(msg);
        break;
      case "ice-candidate":
        await handleIceCandidate(msg);
        break;
    }
  };

  ws.onclose = () => {
    if (running) {
      setTimeout(() => connectSignaling(), 5000);
    }
  };

  ws.onerror = () => {};
}

async function handleOffer(msg) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  peers.set(msg.peerId, pc);

  pc.onicecandidate = (e) => {
    if (e.candidate && ws?.readyState === WebSocket.OPEN) {
      ws.send(
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
    dataChannels.set(msg.peerId, dc);

    dc.onmessage = (event) => {
      handleProxyRequest(msg.peerId, event.data);
    };

    dc.onclose = () => {
      dataChannels.delete(msg.peerId);
      pc.close();
      peers.delete(msg.peerId);
    };
  };

  pc.onconnectionstatechange = () => {
    if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
      dataChannels.delete(msg.peerId);
      pc.close();
      peers.delete(msg.peerId);
    }
  };

  await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  ws.send(
    JSON.stringify({
      type: "answer",
      peerId: msg.peerId,
      answer: pc.localDescription,
    })
  );
}

async function handleIceCandidate(msg) {
  const pc = peers.get(msg.peerId);
  if (pc) {
    await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  }
}

async function handleProxyRequest(peerId, rawData) {
  const dc = dataChannels.get(peerId);
  if (!dc) return;

  try {
    const request = JSON.parse(rawData);

    if (isBlocked(request.url)) {
      dc.send(JSON.stringify({ error: "blocked", code: 403 }));
      return;
    }

    const response = await fetch(request.url, {
      method: request.method || "GET",
      headers: request.headers || {},
      body: request.body || null,
    });

    const body = await response.text();
    dataRelayed += new Blob([body]).size;

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

function isBlocked(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    if (
      host === "localhost" ||
      host === "localhost.localdomain" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]" ||
      host.startsWith("127.") ||
      host.startsWith("10.") ||
      host.startsWith("192.168.") ||
      host.startsWith("169.254.") ||
      host.startsWith("[") ||
      host.match(/^172\.(1[6-9]|2\d|3[01])\./) ||
      host.match(/^0\./) ||
      host.match(/^fc[0-9a-f]{2}:/) ||
      host.match(/^fd[0-9a-f]{2}:/) ||
      host.match(/^fe80:/)
    ) {
      return true;
    }
    const blockedPorts = [22, 23, 25, 445, 3389];
    if (u.port && blockedPorts.includes(Number(u.port))) {
      return true;
    }
    return false;
  } catch {
    return true;
  }
}
