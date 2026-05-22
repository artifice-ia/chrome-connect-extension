const DEFAULT_RELAY_URL = 'wss://relay.artificeia.mx'

function normalizeRelayUrl(value) {
  const trimmed = String(value || '').trim()
  if (!trimmed) return DEFAULT_RELAY_URL
  return trimmed
}

function setStatus(kind, message) {
  const status = document.getElementById('status')
  if (!status) return
  status.dataset.kind = kind || ''
  status.textContent = message || ''
}

async function checkRelayReachable(relayUrl, token) {
  const trimmedToken = String(token || '').trim()
  if (!trimmedToken) {
    setStatus('error', 'Client token required. Save your token to connect.')
    return
  }

  // Derive HTTPS URL from WSS URL for reachability check
  let httpUrl
  try {
    const parsed = new URL(relayUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = '/'
    httpUrl = parsed.toString()
  } catch {
    setStatus('error', `Invalid relay URL: ${relayUrl}`)
    return
  }

  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 3000)
  try {
    const res = await fetch(httpUrl, {
      method: 'HEAD',
      signal: ctrl.signal,
    })
    if (res.status === 401) {
      setStatus('error', 'Relay reachable but token was rejected. Check token and save again.')
      return
    }
    // Any response (even 404) means the server is up
    setStatus('ok', `Relay reachable at ${relayUrl}`)
  } catch {
    // Public relays may not respond to HTTP HEAD — that's OK
    setStatus('', `Relay URL saved: ${relayUrl} (could not verify reachability)`)
  } finally {
    clearTimeout(t)
  }
}

async function load() {
  const stored = await chrome.storage.local.get(['relayUrl', 'gatewayToken'])
  const relayUrl = normalizeRelayUrl(stored.relayUrl)
  const token = String(stored.gatewayToken || '').trim()
  document.getElementById('relay-url-input').value = relayUrl
  document.getElementById('token').value = token
  await checkRelayReachable(relayUrl, token)
}

async function save() {
  const relayUrlInput = document.getElementById('relay-url-input')
  const tokenInput = document.getElementById('token')
  const relayUrl = normalizeRelayUrl(relayUrlInput.value)
  try {
    const parsed = new URL(relayUrl)
    if (parsed.protocol !== 'wss:') throw new Error('not wss')
  } catch {
    setStatus('error', `Relay URL must start with wss:// (got: ${relayUrl})`)
    return
  }
  const token = String(tokenInput.value || '').trim()
  await chrome.storage.local.set({ relayUrl, gatewayToken: token })
  relayUrlInput.value = relayUrl
  tokenInput.value = token
  await checkRelayReachable(relayUrl, token)
}

document.getElementById('save').addEventListener('click', () => void save())
void load()
