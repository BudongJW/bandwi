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

## Quick Start

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

## 快速开始

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

## 许可证

MIT
