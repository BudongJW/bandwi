# Bandwi

**Free VPN powered by a P2P residential proxy network.**

Users get free VPN access to overseas IPs while simultaneously contributing their own residential IP as a proxy node. This creates a self-sustaining two-sided marketplace where supply and demand grow together.

## How It Works

```
 [User A - Seoul]              [User B - Tokyo]
   wants JP IP  ◄──WebRTC──►   wants KR IP
   shares KR IP                 shares JP IP
```

1. **Install** the Chrome extension
2. **Connect** to a VPN exit country (US, JP, KR, SG, ...)
3. **Contribute** your IP as a proxy node (opt-in toggle with bandwidth cap)

Your browser traffic is routed through a peer's residential IP, while your IP serves as an exit node for others. All traffic is filtered — no access to private networks or dangerous ports.

## Architecture

```
bandwi/
  extension/           # Chrome Extension (Manifest V3)
    manifest.json
    popup/             # UI - connect/disconnect, node toggle, stats
    background/        # Service Worker, WebRTC peer node, proxy manager
    icons/
  server/              # Signaling & Registry Server (Node.js)
    signaling.js       # WebSocket signaling + REST API
    package.json
```

### Key Components

| Component | Technology | Role |
|-----------|-----------|------|
| VPN Routing | `chrome.proxy` API + PAC script | Route browser traffic through peer SOCKS5 |
| P2P Transport | WebRTC Data Channel | Direct peer-to-peer proxy relay |
| Signaling | WebSocket (ws) | Peer discovery and WebRTC offer/answer exchange |
| Node Registry | In-memory Map + REST API | Track available nodes by country |

## Quick Start

### Signaling Server

```bash
cd server
npm install
npm start
# Server runs on :8787
```

### Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select the `extension/` folder
4. Click the Bandwi icon in the toolbar

## Safety & Transparency

Unlike Hola VPN, Bandwi is built on **transparent consent**:

- Node contribution is **opt-in** with a visible toggle
- Users set their own **bandwidth limit** (1-50 Mbps)
- **Traffic filtering** blocks access to private networks (127.x, 10.x, 192.168.x, 172.16-31.x) and dangerous ports (SSH, SMTP, SMB, RDP)
- All proxy requests are logged locally for user review
- Open source — verify the code yourself

## Roadmap

- [ ] MVP Chrome extension with basic P2P proxy
- [ ] GeoIP-based node country detection
- [ ] End-to-end encryption for relayed traffic
- [ ] Node reputation and reliability scoring
- [ ] Mobile app (Android/iOS)
- [ ] B2B API for residential proxy access
- [ ] Token-based incentive system for node contributors

## License

MIT

---

# Bandwi (Chinese / 中文)

**免费VPN，由P2P住宅代理网络驱动。**

用户可以免费使用VPN访问海外IP，同时将自己的住宅IP作为代理节点贡献出来。这创造了一个供需共同增长的自维持双边市场。

## 工作原理

```
 [用户A - 首尔]                [用户B - 东京]
   需要日本IP  ◄──WebRTC──►   需要韩国IP
   共享韩国IP                   共享日本IP
```

1. **安装** Chrome扩展程序
2. **连接** 到VPN出口国家（美国、日本、韩国、新加坡等）
3. **贡献** 你的IP作为代理节点（可选开关，带宽可设上限）

你的浏览器流量通过对等节点的住宅IP路由，而你的IP则作为其他用户的出口节点。所有流量都经过过滤——禁止访问私有网络或危险端口。

## 架构

```
bandwi/
  extension/           # Chrome扩展 (Manifest V3)
    manifest.json
    popup/             # UI - 连接/断开、节点开关、统计
    background/        # Service Worker、WebRTC对等节点、代理管理器
    icons/
  server/              # 信令和注册服务器 (Node.js)
    signaling.js       # WebSocket信令 + REST API
    package.json
```

### 核心组件

| 组件 | 技术 | 作用 |
|------|------|------|
| VPN路由 | `chrome.proxy` API + PAC脚本 | 通过对等SOCKS5路由浏览器流量 |
| P2P传输 | WebRTC Data Channel | 点对点直接代理转发 |
| 信令 | WebSocket (ws) | 节点发现和WebRTC offer/answer交换 |
| 节点注册 | 内存Map + REST API | 按国家跟踪可用节点 |

## 快速开始

### 信令服务器

```bash
cd server
npm install
npm start
# 服务器运行在 :8787
```

### Chrome扩展

1. 打开 `chrome://extensions/`
2. 启用 **开发者模式**
3. 点击 **加载已解压的扩展程序** → 选择 `extension/` 文件夹
4. 点击工具栏中的 Bandwi 图标

## 安全与透明

与Hola VPN不同，Bandwi基于**透明同意**构建：

- 节点贡献是**可选的**，带有可见的开关
- 用户自行设置**带宽上限**（1-50 Mbps）
- **流量过滤**阻止访问私有网络（127.x、10.x、192.168.x、172.16-31.x）和危险端口（SSH、SMTP、SMB、RDP）
- 所有代理请求在本地记录，供用户查看
- 开源——你可以自行验证代码

## 开发路线

- [ ] MVP Chrome扩展，基础P2P代理功能
- [ ] 基于GeoIP的节点国家检测
- [ ] 中继流量端到端加密
- [ ] 节点信誉和可靠性评分
- [ ] 移动应用（Android/iOS）
- [ ] B2B API，提供住宅代理访问
- [ ] 基于代币的节点贡献者激励系统

## 许可证

MIT
