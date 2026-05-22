# Security Model

## What the extension can do

When attached to a tab, the extension gives the relay server full Chrome DevTools Protocol access to that tab. This includes:

- Arbitrary JavaScript execution (`Runtime.evaluate`)
- DOM read/write, form fill, file input injection
- Navigation to any URL
- Screenshot and PDF capture
- Reading cached resources including auth tokens and API responses

This is intentional — it is the product. The operator explicitly attaches tabs to share them.

## Trust boundaries

```
Relay server (127.0.0.1:18792)
    ↓  wss:// token-authenticated
Extension (chrome.debugger API)
    ↓  chrome.debugger.sendCommand
Browser tab
```

**The extension trusts the relay completely.** It forwards CDP commands from the relay to `chrome.debugger.sendCommand` without its own allowlist check. The relay (plugin) enforces `CDP_ALLOWED` before sending — the extension is a trusted executor, not an independent security boundary.

Implication: if the relay is compromised or the extension connects to a rogue relay, the relay can issue any CDP command. The `relayUrl` validation (wss:// scheme only) raises the bar — storage compromise alone is not enough to redirect to a plaintext attacker endpoint.

**For v1 single-tenant with a loopback relay, this is the accepted design.** The relay runs on 127.0.0.1, the extension requires a pre-minted token, and the relay enforces the allowlist before the extension sees any command.

## Before multi-tenant or public relay

The extension should enforce `CDP_ALLOWED` independently before calling `chrome.debugger.sendCommand`. This makes the extension a second, independent security layer rather than relying solely on the relay's allowlist. Without this, a compromised relay (or a relay operated by a different party in a multi-tenant setup) can send unrestricted CDP commands.

## URL scheme allowlist (`Target.createTarget`)

The `Target.createTarget` handler validates the URL scheme before opening a new tab:

- Allowed: `http:`, `https:`, `about:` (for `about:blank`)
- Blocked: `javascript:`, `data:`, `chrome-extension:`, and all others

Note: this only governs initial tab creation. Once a tab is open, `Page.navigate` (allowed by the relay's `CDP_ALLOWED`) can navigate to any http/https URL. The URL allowlist on `Target.createTarget` prevents scheme-based attacks on tab creation, not subsequent navigation.

## `relayUrl` storage validation

`getRelayUrl()` validates `wss://` scheme before connecting. An invalid stored URL falls back to `DEFAULT_RELAY_URL` with a `console.warn`. This prevents an attacker with `chrome.storage` write access from redirecting the extension to a plaintext `ws://` relay and exfiltrating the auth token via network traffic analysis.
