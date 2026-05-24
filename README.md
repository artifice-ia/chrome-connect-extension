# Chrome Connect Extension

Chrome extension that gives your AI agent (Claude Code or OpenClaw) access to your browser via Chrome DevTools Protocol — with you in control of exactly which tabs are shared.

Pair with [chrome-connect-relay](https://github.com/Agent-Crafting-Table/chrome-connect-relay) to get started.

## What your agent can do on shared tabs

- Navigate to URLs
- Click, type, fill forms
- Evaluate JavaScript
- Capture screenshots
- Read page content and DOM

You decide which tabs are shared. Unshared tabs are invisible to the agent.

---

## Install

The extension is not on the Chrome Web Store — load it unpacked:

1. Download or clone this repo.
2. Open Chrome and go to `chrome://extensions`.
3. Enable **Developer mode** (toggle in the top-right corner).
4. Click **Load unpacked** and select the repo folder.

The extension icon appears in your toolbar.

---

## Configure

Before connecting, you need a relay running and a client token. Set up [chrome-connect-relay](https://github.com/Agent-Crafting-Table/chrome-connect-relay) first — it walks you through starting the relay and running the pair/redeem flow to get your `art_...` token.

Once you have the token:

1. Click the extension icon → **Options** (or right-click → *Manage extension* → *Extension options*).
2. Set **Relay URL**:
   - Local relay (same machine): `ws://127.0.0.1:18792`
   - Hosted relay: `wss://your-relay-host`
3. Paste your `art_...` token into **Client Token**.
4. Click **Save**. The extension connects automatically.

The indicator shows WebSocket state only — not whether your token is valid. To confirm the relay accepted your token, ask your agent to call `artifice_status` ([relay docs](https://github.com/Agent-Crafting-Table/chrome-connect-relay)).

---

## Usage

**Share a tab:** navigate to the page you want the agent to see, then click the extension icon and toggle sharing on. You can share multiple tabs.

**Unshare a tab:** click the extension icon again and toggle sharing off.

Your agent calls `artifice_status` to list shared tabs and their session IDs, then uses `artifice_cdp` to control them. See [chrome-connect-relay](https://github.com/Agent-Crafting-Table/chrome-connect-relay) for the full tool reference.

> **What the agent can read:** On a shared tab, the agent has full JavaScript access — including `localStorage`, `sessionStorage`, cookies, form fields, and any auth tokens visible to the page. Only share tabs you're comfortable giving the agent complete access to.

---

## Security

This extension was built with deliberate security choices:

- **Tab-level isolation** — The agent only sees tabs you explicitly share. Other tabs are unreachable.
- **Token authentication** — Every relay connection requires a bearer token (`art_...`). The raw token is stored in Chrome's local extension storage (not synced to Google). The relay stores only a hash of the token — the raw value is never held server-side.
- **Relay URL validation** — Remote relays must use `wss://` (TLS). Plain `ws://` is only accepted for loopback addresses (`127.0.0.1`, `localhost`) on the same physical machine — never for remote hosts. Invalid URLs are rejected at save time with a hard error, no silent fallback.
- **Loopback-only default** — The relay binds to `127.0.0.1` by default. Nothing is reachable from outside your machine without deliberate configuration.
- **Protocol version handshake** — Client and relay verify protocol compatibility on connect.

See [SECURITY.md](SECURITY.md) for the full threat model, including the hosted-relay trust perimeter and multi-tenant roadmap.

---

## License

MIT
