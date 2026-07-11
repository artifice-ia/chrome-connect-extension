# Security Model

## What the extension can do

When attached to a tab, the extension gives the relay server full Chrome DevTools Protocol access to that tab. This includes:

- Arbitrary JavaScript execution (`Runtime.evaluate`)
- DOM read/write, form fill, file input injection
- Navigation to any URL
- Screenshot and PDF capture
- Reading cached resources including auth tokens and API responses

This is intentional — it is the product. The operator explicitly attaches tabs to share them.

## Two deployment models — different trust perimeters

### Local relay (127.0.0.1)

```
Bot process
    │ owns relay
    ▼
Relay server (127.0.0.1:18792)  ← loopback only, no external network exposure
    ↓  ws:// plaintext loopback (no network interception possible)
Extension (chrome.debugger API)
    ↓  chrome.debugger.sendCommand
Browser tab
```

Trust perimeter: the host machine. The relay is not reachable from outside. The auth token in transit never leaves the machine. The relay operator is the bot owner.

**Accepted for v1 single-tenant:** extension trusts relay completely; relay enforces `CDP_ALLOWED` before sending. If the relay process is compromised, an attacker on the same machine has browser control.

### Hosted/public relay (wss://relay.example.com)

```
Bot process
    │  MCP adapter (or legacy plugin adapter)
    ▼
Relay server (public endpoint, TLS)
    ↓  wss:// token-authenticated
Extension (chrome.debugger API)
    ↓  chrome.debugger.sendCommand
Browser tab
```

Trust perimeter expands to: the relay operator, the network path (TLS), and anyone who can compromise the relay process. The relay operator can issue any CDP command the extension forwards — which is all of them (see below).

## The extension has no independent CDP allowlist

The relay enforces `CDP_ALLOWED` before forwarding commands. The extension forwards whatever the relay sends to `chrome.debugger.sendCommand` without its own check.

**For loopback relay:** acceptable. Relay is the sole trust boundary; if it's compromised the host is already lost.

**For hosted relay:** the relay operator is not necessarily the same party as the browser owner. The extension should enforce `CDP_ALLOWED` independently before calling `chrome.debugger.sendCommand`, making it a second security layer that survives relay compromise. This is required before:

- Multi-tenant deployments (multiple bots, one relay)
- Any relay not operated by the browser owner

## `relayUrl` storage validation

`getRelayUrl()` validates the URL before connecting. If invalid, connection is **refused with an error** — no silent fallback.

Allowed:
- `wss://` — any host (TLS required for non-loopback to prevent MITM token exfil)
- `ws://` — loopback only (`127.0.0.1`, `localhost`, `::1`); loopback traffic cannot be intercepted at the network level so TLS is not required

Rejected with error: `ws://` on any non-loopback host. This prevents an attacker with `chrome.storage` write access from redirecting the extension to a plaintext remote relay and exfiltrating the auth token via network interception.

## URL scheme allowlist (`Target.createTarget`)

The `Target.createTarget` handler validates the URL scheme before opening a new tab:

- Allowed: `http:`, `https:`, `about:` (for `about:blank`)
- Blocked: `javascript:`, `data:`, `chrome-extension:`, and all others

Note: this only governs initial tab creation. Once a tab is open, `Page.navigate` (in the relay's `CDP_ALLOWED`) can navigate to any http/https URL. The allowlist prevents scheme-based attacks at creation time, not subsequent navigation.
