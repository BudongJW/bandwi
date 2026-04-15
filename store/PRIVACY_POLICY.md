# Bandwi VPN - Privacy Policy

**Last updated: April 15, 2026**

## Overview

Bandwi VPN ("Bandwi", "we", "our") is a peer-to-peer VPN Chrome extension. This policy explains what data we collect, how we use it, and your rights.

## Data We Collect

### Data We Do NOT Collect
- Browsing history or visited URLs
- Personal information (name, email, phone)
- IP addresses of users (beyond ephemeral signaling)
- Cookies or tracking identifiers
- Keystroke or form input data

### Data We Process Temporarily
- **IP addresses**: Used only during WebSocket signaling to facilitate peer-to-peer connections. Not stored permanently.
- **Country-level geolocation**: Derived from IP during registration to match peers by country. Not stored after session ends.
- **Bandwidth usage statistics**: Aggregate data relayed counter, stored locally in your browser only.

### Data Stored Locally (on your device only)
- VPN connection preferences (selected country)
- Node contribution toggle state
- Bandwidth limit setting
- Session statistics (peers connected, data relayed, uptime)

This data is stored using Chrome's `chrome.storage` API and never transmitted to our servers.

## How P2P Proxy Works

When you use Bandwi as a VPN:
- Your traffic is routed through another user's residential IP via WebRTC Data Channel
- The relay node processes HTTP requests on your behalf
- The relay node does NOT log or store your traffic

When you contribute as a node:
- Other users' HTTP requests are relayed through your IP
- Built-in traffic filtering prevents access to private networks (127.x, 10.x, 192.168.x, 172.16-31.x) and dangerous ports (SSH, SMTP, SMB, RDP)
- You can disable node contribution at any time
- You control the maximum bandwidth shared (1-50 Mbps)

## Signaling Server

Our signaling server facilitates WebRTC peer discovery:
- Receives WebSocket connections for peer matching
- Relays WebRTC offer/answer/ICE candidates between peers
- Maintains an in-memory registry of active nodes (not persisted to disk)
- Automatically removes stale entries after 5 minutes of inactivity

## Third-Party Services

- **Google STUN server** (stun.l.google.com:19302): Used for WebRTC NAT traversal. Subject to Google's privacy policy.

## Data Security

- All P2P connections use WebRTC with DTLS encryption
- No user data is stored on persistent storage on our servers
- The extension source code is open source and auditable

## Your Rights

- **Opt-out**: Disable node contribution at any time via the toggle
- **Delete**: Clear local data by removing the extension
- **Inspect**: Review all source code at https://github.com/BudongJW/bandwi

## Changes to This Policy

We may update this policy from time to time. Changes will be posted to our GitHub repository.

## Contact

For privacy-related inquiries, open an issue at:
https://github.com/BudongJW/bandwi/issues
