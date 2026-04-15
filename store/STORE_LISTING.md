# Chrome Web Store Listing

## Name
Bandwi VPN - Free P2P Proxy

## Short Description (132 chars max)
Free VPN powered by a peer-to-peer residential proxy network. Browse through real IPs while contributing yours to help others.

## Detailed Description
Bandwi is a free VPN Chrome extension powered by a peer-to-peer residential proxy network.

HOW IT WORKS:
- Install the extension and connect to a VPN exit country (US, JP, KR, SG)
- Your browser traffic is routed through another user's residential IP
- Optionally share your IP as a proxy node to help others (opt-in)
- Everyone benefits: free VPN access in exchange for sharing bandwidth

KEY FEATURES:
- Free VPN with multiple exit countries
- P2P residential proxy network (real ISP IPs, not datacenter)
- Opt-in node contribution with bandwidth limit control (1-50 Mbps)
- Built-in traffic filtering blocks access to private networks and dangerous ports
- Real-time stats: peer count, data relayed, uptime
- Dark purple themed UI
- Open source: https://github.com/BudongJW/bandwi

SAFETY & TRANSPARENCY:
Unlike other P2P VPN services, Bandwi is built on transparent consent:
- Node sharing is opt-in with a visible toggle
- You control your bandwidth limit
- All traffic is filtered (no access to private IPs or dangerous ports)
- Fully open source - verify the code yourself
- No account required

PRIVACY:
- No registration or login required
- No browsing history collected
- No personal data stored on servers
- P2P connections use WebRTC with STUN/TURN
- Signaling server only facilitates peer discovery

## Category
Productivity

## Language
English

## Assets
- Icon 128x128: extension/icons/icon128.png
- Small promo tile (440x280): store/promo-small.png
- Marquee promo (1400x560): store/promo-marquee.png
- Screenshots: (capture after loading extension)

## Single Purpose Description
This extension provides VPN functionality by routing browser traffic through a P2P residential proxy network.

## Host Permission Justification
<all_urls> is required to route all browser traffic through the VPN proxy using the chrome.proxy API with PAC scripts. Without this permission, the extension cannot function as a VPN.

## Permission Justifications
- proxy: Core functionality - route browser traffic through P2P proxy nodes
- storage: Save user preferences (bandwidth limit, node toggle state)
- alarms: Keep service worker alive for persistent P2P node connections
- webRequest: Monitor proxy connection status and handle authentication
