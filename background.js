const DEFAULT_RELAY_URL = 'wss://relay.artificeia.mx'

const BADGE = {
  on: { text: 'ON', color: '#FF5A36' },
  off: { text: '', color: '#000000' },
  connecting: { text: '…', color: '#F59E0B' },
  error: { text: '!', color: '#B91C1C' },
}

/** @type {WebSocket|null} */
let relayWs = null
/** @type {Promise<void>|null} */
let relayConnectPromise = null

let debuggerListenersInstalled = false

let nextSession = 1

/** @type {Map<number, {state:'connecting'|'connected'|'pending_reattach', sessionId?:string, targetId?:string, attachOrder?:number}>} */
const tabs = new Map()
/** @type {Map<string, number>} */
const tabBySession = new Map()
/** @type {Map<string, number>} */
const childSessionToTab = new Map()

// ===== FIX #1 & #2: Auto-reconnect state =====
let reconnectAttempt = 0
let reconnectTimer = null
let reconnectEpoch = 0

function nowStack() {
  try {
    return new Error().stack || ''
  } catch {
    return ''
  }
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]'])

async function getRelayUrl() {
  const stored = await chrome.storage.local.get(['relayUrl'])
  const raw = String(stored.relayUrl || '').trim()
  if (!raw) return DEFAULT_RELAY_URL
  try {
    const parsed = new URL(raw)
    const isWss = parsed.protocol === 'wss:'
    const isLoopbackWs = parsed.protocol === 'ws:' && LOOPBACK_HOSTS.has(parsed.hostname)
    if (!isWss && !isLoopbackWs) throw new Error('invalid scheme')
    return raw
  } catch {
    throw new Error(`Invalid relay URL in storage (use wss:// for remote or ws://127.0.0.1 for local): ${raw}`)
  }
}

async function getGatewayToken() {
  const stored = await chrome.storage.local.get(['gatewayToken'])
  const token = String(stored.gatewayToken || '').trim()
  return token || ''
}

function setBadge(tabId, kind) {
  const cfg = BADGE[kind]
  void chrome.action.setBadgeText({ tabId, text: cfg.text })
  void chrome.action.setBadgeBackgroundColor({ tabId, color: cfg.color })
  void chrome.action.setBadgeTextColor({ tabId, color: '#FFFFFF' }).catch(() => {})
}

async function ensureRelayConnection() {
  if (relayWs && relayWs.readyState === WebSocket.OPEN) return
  if (relayConnectPromise) return await relayConnectPromise

  relayConnectPromise = (async () => {
    const relayUrl = await getRelayUrl()
    const gatewayToken = await getGatewayToken()

    if (!gatewayToken) {
      throw new Error(
        'Missing gatewayToken in extension settings (chrome.storage.local.gatewayToken)',
      )
    }

    // Close any lingering socket before opening a new one
    if (relayWs && relayWs.readyState !== WebSocket.CLOSED) {
      const stale = relayWs
      stale.onclose = null
      stale.onerror = null
      try { stale.close() } catch {}
    }
    relayWs = null

    const ws = new WebSocket(relayUrl)
    relayWs = ws

    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.close()
        reject(new Error('WebSocket connect timeout'))
      }, 10000)
      let connected = false
      ws.onopen = () => {
        connected = true
        // Send auth handshake — token never travels in the URL
        ws.send(JSON.stringify({ method: 'auth', token: gatewayToken, version: 1 }))
        // Temporary handlers for the auth phase
        ws.onclose = (ev) => {
          clearTimeout(t)
          reject(new Error(`Closed during auth (${ev.code} ${ev.reason || 'no reason'})`))
        }
        ws.onerror = () => {
          clearTimeout(t)
          reject(new Error('Error during auth'))
        }
        ws.onmessage = (event) => {
          let msg
          try { msg = JSON.parse(String(event.data || '')) } catch { msg = null }
          if (!msg || msg.method !== 'auth') {
            clearTimeout(t)
            ws.close()
            reject(new Error('Unexpected message during auth'))
            return
          }
          if (!msg.ok) {
            clearTimeout(t)
            ws.close()
            reject(new Error(`Auth rejected: ${msg.error || 'unknown'}`))
            return
          }
          clearTimeout(t)
          // Auth confirmed — install permanent handlers
          ws.onmessage = (event) => void onRelayMessage(String(event.data || ''))
          ws.onclose = () => onRelayClosed('closed')
          ws.onerror = () => onRelayClosed('error')
          resolve()
        }
      }
      ws.onerror = () => {
        clearTimeout(t)
        if (!connected) reject(new Error('WebSocket connect failed'))
      }
      ws.onclose = (ev) => {
        clearTimeout(t)
        if (!connected) reject(new Error(`WebSocket closed (${ev.code} ${ev.reason || 'no reason'})`))
      }
    })

    if (!debuggerListenersInstalled) {
      debuggerListenersInstalled = true
      chrome.debugger.onEvent.addListener(onDebuggerEvent)
      chrome.debugger.onDetach.addListener(onDebuggerDetach)
    }

    // ===== FIX #2: Reset reconnect counter on successful connection =====
    reconnectEpoch++
    reconnectAttempt = 0
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
  })()

  try {
    await relayConnectPromise
  } finally {
    relayConnectPromise = null
  }
}

// ===== FIX #1: DON'T detach debugger sessions on WS drop =====
function onRelayClosed(reason) {
  relayWs = null
  reconnectEpoch++ // invalidate any in-flight reconnect callbacks from the previous cycle

  // Keep debugger attached — only update badge to show disconnected state.
  // When we reconnect, we'll re-announce existing sessions.
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state === 'connected') {
      setBadge(tabId, 'connecting')
      void chrome.action.setTitle({
        tabId,
        title: 'Artífice Connect: reconnecting…',
      })
    }
  }
  // DON'T: tabs.clear(), tabBySession.clear(), childSessionToTab.clear()
  // DON'T: chrome.debugger.detach()

  // ===== FIX #2: Schedule auto-reconnect =====
  scheduleReconnect()
}

function scheduleReconnect() {
  if (reconnectTimer) return // already scheduled
  const epoch = reconnectEpoch
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000) + Math.random() * 500
  reconnectAttempt++
  console.log(`[Artífice Relay] Scheduling reconnect attempt ${reconnectAttempt} in ${Math.round(delay)}ms`)

  reconnectTimer = setTimeout(async () => {
    if (epoch !== reconnectEpoch) { reconnectTimer = null; return } // superseded
    try {
      await ensureRelayConnection()
      if (epoch !== reconnectEpoch) { reconnectTimer = null; return } // superseded during connect
      console.log('[Artífice Relay] Reconnected successfully')

      // Re-announce all still-attached tabs
      for (const [tabId, tab] of tabs.entries()) {
        if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
          try {
            const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
            if (!chromeTab) {
              cleanupTab(tabId)
              continue
            }

            // Verify debugger still attached
            await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
              expression: '1',
              returnByValue: true,
            })

            // Re-announce to the relay server
            const info = /** @type {any} */ (
              await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
            )
            const targetInfo = info?.targetInfo
            tab.targetId = String(targetInfo?.targetId || '').trim() || tab.targetId

            sendToRelay({
              method: 'forwardCDPEvent',
              params: {
                method: 'Target.attachedToTarget',
                params: {
                  sessionId: tab.sessionId,
                  targetInfo: { ...targetInfo, attached: true },
                  waitingForDebugger: false,
                },
              },
            })
            setBadge(tabId, 'on')
            void chrome.action.setTitle({
              tabId,
              title: 'Artífice Connect: attached (click to detach)',
            })
            console.log(`[Artífice Relay] Re-announced tab ${tabId} (session: ${tab.sessionId})`)
          } catch (err) {
            console.warn(`[Artífice Relay] Failed to re-announce tab ${tabId}:`, err)
            cleanupTab(tabId)
          }
        }
      }
    } catch (err) {
      console.log(`[Artífice Relay] Reconnect failed: ${err instanceof Error ? err.message : err}`)
      reconnectTimer = null
      scheduleReconnect()
      return
    }
    reconnectTimer = null
  }, delay)
}

// ===== FIX #3: Persist state to chrome.storage.session for MV3 worker restarts =====
async function persistState() {
  try {
    const tabEntries = []
    for (const [tabId, tab] of tabs.entries()) {
      if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
        tabEntries.push({ tabId, sessionId: tab.sessionId, targetId: tab.targetId, attachOrder: tab.attachOrder })
      }
    }
    await chrome.storage.session.set({ relayTabs: tabEntries, nextSession })
  } catch {
    // chrome.storage.session may not be available in all contexts
  }
}

async function restoreState() {
  try {
    const stored = await chrome.storage.session.get(['relayTabs', 'nextSession'])
    if (!stored.relayTabs?.length) return false
    if (stored.nextSession) nextSession = stored.nextSession

    let restored = 0
    for (const entry of stored.relayTabs) {
      const { tabId, sessionId, targetId, attachOrder } = entry

      const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
      if (!chromeTab) continue

      try {
        await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
          expression: '1',
          returnByValue: true,
        })
      } catch {
        console.log(`[Artífice Relay] Tab ${tabId} debugger lost — attempting re-attach`)
        try {
          await chrome.debugger.attach({ tabId }, '1.3')
          await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
          await chrome.debugger.sendCommand({ tabId }, 'Network.enable')
          console.log(`[Artífice Relay] Tab ${tabId} re-attached successfully`)
        } catch (reattachErr) {
          console.warn(`[Artífice Relay] Tab ${tabId} re-attach failed:`, reattachErr)
          setBadge(tabId, 'off')
          continue
        }
      }

      // Verify the tab still holds the same target — Chrome reuses tab IDs
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo').catch(() => null)
      )
      const currentTargetId = String(info?.targetInfo?.targetId || '').trim()
      if (targetId && currentTargetId && currentTargetId !== targetId) {
        console.warn(`[Artífice Relay] Tab ${tabId} targetId changed (${targetId} → ${currentTargetId}) — dropping stale session`)
        await chrome.debugger.detach({ tabId }).catch(() => {})
        continue
      }

      tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
      tabBySession.set(sessionId, tabId)
      setBadge(tabId, 'on')
      restored++
    }

    if (restored > 0) {
      console.log(`[Artífice Relay] Restored ${restored} tab(s) from session storage`)

      if (!debuggerListenersInstalled) {
        debuggerListenersInstalled = true
        chrome.debugger.onEvent.addListener(onDebuggerEvent)
        chrome.debugger.onDetach.addListener(onDebuggerDetach)
      }

      try {
        await ensureRelayConnection()
        for (const [tabId, tab] of tabs.entries()) {
          if (tab.state === 'connected' && tab.sessionId && tab.targetId) {
            try {
              const info = /** @type {any} */ (
                await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
              )
              sendToRelay({
                method: 'forwardCDPEvent',
                params: {
                  method: 'Target.attachedToTarget',
                  params: {
                    sessionId: tab.sessionId,
                    targetInfo: { ...(info?.targetInfo || {}), attached: true },
                    waitingForDebugger: false,
                  },
                },
              })
            } catch (err) {
              console.warn(`[Artífice Relay] restoreState: failed to re-announce tab ${tabId}:`, err)
              cleanupTab(tabId)
            }
          }
        }
      } catch {
        scheduleReconnect()
      }
      return true
    }
  } catch (err) {
    console.warn('[Artífice Relay] Failed to restore state:', err)
  }
  return false
}

function cleanupTab(tabId) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)
  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }
  setBadge(tabId, 'off')
  void persistState()
}

function sendToRelay(payload) {
  const ws = relayWs
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    throw new Error('Relay not connected')
  }
  ws.send(JSON.stringify(payload))
}

async function maybeOpenHelpOnce() {
  try {
    const stored = await chrome.storage.local.get(['helpOnErrorShown'])
    if (stored.helpOnErrorShown === true) return
    await chrome.storage.local.set({ helpOnErrorShown: true })
    await chrome.runtime.openOptionsPage()
  } catch {
    // ignore
  }
}

async function onRelayMessage(text) {
  /** @type {any} */
  let msg
  try {
    msg = JSON.parse(text)
  } catch {
    return
  }

  if (msg && msg.method === 'ping') {
    try {
      sendToRelay({ method: 'pong' })
    } catch {
      // ignore
    }
    return
  }

  if (msg && typeof msg.id === 'number' && msg.method === 'forwardCDPCommand') {
    try {
      const result = await handleForwardCdpCommand(msg)
      sendToRelay({ id: msg.id, result })
    } catch (err) {
      try { sendToRelay({ id: msg.id, error: err instanceof Error ? err.message : String(err) }) } catch { /* WS closed */ }
    }
  }
}

function getTabBySessionId(sessionId) {
  const direct = tabBySession.get(sessionId)
  if (direct) return { tabId: direct, kind: 'main' }
  const child = childSessionToTab.get(sessionId)
  if (child) return { tabId: child, kind: 'child' }
  return null
}

function getTabByTargetId(targetId) {
  for (const [tabId, tab] of tabs.entries()) {
    if (tab.targetId === targetId) return tabId
  }
  return null
}

async function attachTab(tabId, opts = {}) {
  const debuggee = { tabId }
  await chrome.debugger.attach(debuggee, '1.3')
  await chrome.debugger.sendCommand(debuggee, 'Page.enable').catch(() => {})

  const info = /** @type {any} */ (await chrome.debugger.sendCommand(debuggee, 'Target.getTargetInfo'))
  const targetInfo = info?.targetInfo
  const targetId = String(targetInfo?.targetId || '').trim()
  if (!targetId) {
    throw new Error('Target.getTargetInfo returned no targetId')
  }

  const attachOrder = nextSession
  const sessionId = `cb-tab-${nextSession++}`

  tabs.set(tabId, { state: 'connected', sessionId, targetId, attachOrder })
  tabBySession.set(sessionId, tabId)
  void chrome.action.setTitle({
    tabId,
    title: 'Artífice Connect: attached (click to detach)',
  })

  if (!opts.skipAttachedEvent) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.attachedToTarget',
          params: {
            sessionId,
            targetInfo: { ...targetInfo, attached: true },
            waitingForDebugger: false,
          },
        },
      })
    } catch { /* WS closed — reconnect will re-announce */ }
  }

  setBadge(tabId, 'on')

  // ===== FIX #3: Persist state after attach =====
  void persistState()

  return { sessionId, targetId }
}

async function detachTab(tabId, reason) {
  const tab = tabs.get(tabId)
  if (tab?.sessionId && tab?.targetId) {
    try {
      sendToRelay({
        method: 'forwardCDPEvent',
        params: {
          method: 'Target.detachedFromTarget',
          params: { sessionId: tab.sessionId, targetId: tab.targetId, reason },
        },
      })
    } catch {
      // ignore
    }
  }

  if (tab?.sessionId) tabBySession.delete(tab.sessionId)
  tabs.delete(tabId)

  for (const [childSessionId, parentTabId] of childSessionToTab.entries()) {
    if (parentTabId === tabId) childSessionToTab.delete(childSessionId)
  }

  try {
    await chrome.debugger.detach({ tabId })
  } catch {
    // ignore
  }

  setBadge(tabId, 'off')
  void chrome.action.setTitle({
    tabId,
    title: 'Artífice Connect (click to attach/detach)',
  })

  // ===== FIX #3: Persist state after detach =====
  void persistState()
}

async function connectOrToggleForActiveTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  const tabId = active?.id
  if (!tabId) return

  const existing = tabs.get(tabId)
  if (existing?.state === 'connected') {
    await detachTab(tabId, 'toggle')
    return
  }

  tabs.set(tabId, { state: 'connecting' })
  setBadge(tabId, 'connecting')
  void chrome.action.setTitle({
    tabId,
    title: 'Artífice Connect: connecting to local relay…',
  })

  try {
    await ensureRelayConnection()
    await attachTab(tabId)
  } catch (err) {
    tabs.delete(tabId)
    setBadge(tabId, 'error')
    void chrome.action.setTitle({
      tabId,
      title: 'Artífice Connect: relay not running (open options for setup)',
    })
    void maybeOpenHelpOnce()
    const message = err instanceof Error ? err.message : String(err)
    console.warn('attach failed', message, nowStack())
  }
}

async function handleForwardCdpCommand(msg) {
  const method = String(msg?.params?.method || '').trim()
  const params = msg?.params?.params || undefined
  const sessionId = typeof msg?.params?.sessionId === 'string' ? msg.params.sessionId : undefined

  const bySession = sessionId ? getTabBySessionId(sessionId) : null
  if (sessionId && !bySession) throw new Error(`Unknown sessionId: ${sessionId}`)
  const targetId = typeof params?.targetId === 'string' ? params.targetId : undefined
  const tabId =
    bySession?.tabId ||
    (targetId ? getTabByTargetId(targetId) : null) ||
    (() => {
      const connected = []
      for (const [id, tab] of tabs.entries()) {
        if (tab.state === 'connected') connected.push(id)
      }
      return connected.length === 1 ? connected[0] : null
    })()

  if (!tabId) throw new Error(`No attached tab for method ${method}${tabs.size > 1 ? ' — provide sessionId' : ''}`)

  /** @type {chrome.debugger.DebuggerSession} */
  const debuggee = { tabId }

  if (method === 'Runtime.enable') {
    try {
      await chrome.debugger.sendCommand(debuggee, 'Runtime.disable')
      await new Promise((r) => setTimeout(r, 50))
    } catch {
      // ignore
    }
    return await chrome.debugger.sendCommand(debuggee, 'Runtime.enable', params)
  }

  if (method === 'Target.createTarget') {
    const rawUrl = typeof params?.url === 'string' ? params.url : 'about:blank'
    let parsedUrl
    try { parsedUrl = new URL(rawUrl) } catch { throw new Error(`Invalid URL: ${rawUrl}`) }
    if (!['http:', 'https:', 'about:'].includes(parsedUrl.protocol)) {
      throw new Error(`URL scheme not allowed: ${parsedUrl.protocol}`)
    }
    const url = rawUrl
    const tab = await chrome.tabs.create({ url, active: false })
    if (!tab.id) throw new Error('Failed to create tab')
    await new Promise((r) => setTimeout(r, 100))
    const attached = await attachTab(tab.id)
    return { targetId: attached.targetId }
  }

  if (method === 'Target.closeTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toClose = target ? getTabByTargetId(target) : tabId
    if (!toClose) return { success: false }
    try {
      await chrome.tabs.remove(toClose)
    } catch {
      return { success: false }
    }
    return { success: true }
  }

  if (method === 'Target.activateTarget') {
    const target = typeof params?.targetId === 'string' ? params.targetId : ''
    const toActivate = target ? getTabByTargetId(target) : tabId
    if (!toActivate) return {}
    const tab = await chrome.tabs.get(toActivate).catch(() => null)
    if (!tab) return {}
    if (tab.windowId) {
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {})
    }
    await chrome.tabs.update(toActivate, { active: true }).catch(() => {})
    return {}
  }

  const tabState = tabs.get(tabId)
  const mainSessionId = tabState?.sessionId
  const debuggerSession =
    sessionId && mainSessionId && sessionId !== mainSessionId
      ? { ...debuggee, sessionId }
      : debuggee

  return await chrome.debugger.sendCommand(debuggerSession, method, params)
}

function onDebuggerEvent(source, method, params) {
  const tabId = source.tabId
  if (!tabId) return
  const tab = tabs.get(tabId)
  if (!tab?.sessionId) return

  if (method === 'Target.attachedToTarget' && params?.sessionId) {
    childSessionToTab.set(String(params.sessionId), tabId)
  }

  if (method === 'Target.detachedFromTarget' && params?.sessionId) {
    childSessionToTab.delete(String(params.sessionId))
  }

  try {
    sendToRelay({
      method: 'forwardCDPEvent',
      params: {
        sessionId: source.sessionId || tab.sessionId,
        method,
        params,
      },
    })
  } catch {
    // ignore
  }
}

function onDebuggerDetach(source, reason) {
  const tabId = source.tabId
  if (!tabId) return
  if (!tabs.has(tabId)) return

  // Navigation causes 'target_closed' — don't nuke state, try to re-attach
  if (reason === 'target_closed') {
    const tab = tabs.get(tabId)
    if (tab?.state === 'connected') {
      console.log(`[Artífice Relay] Tab ${tabId} detached (navigation) — will re-attach`)
      tab.state = 'pending_reattach'
      setBadge(tabId, 'connecting')
      // Wait for navigation to settle, then re-attach
      setTimeout(() => void reattachAfterNavigation(tabId), 500)
      return
    }
  }

  void detachTab(tabId, reason)
}

async function reattachAfterNavigation(tabId) {
  const tab = tabs.get(tabId)
  if (!tab || tab.state !== 'pending_reattach') return

  const chromeTab = await chrome.tabs.get(tabId).catch(() => null)
  if (!chromeTab) {
    console.log(`[Artífice Relay] Tab ${tabId} gone after navigation — cleaning up`)
    cleanupTab(tabId)
    return
  }

  // Retry re-attach up to 3 times (page might still be loading)
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.debugger.attach({ tabId }, '1.3')
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.enable')
      await chrome.debugger.sendCommand({ tabId }, 'Network.enable')

      // Get new target info and re-announce
      const info = /** @type {any} */ (
        await chrome.debugger.sendCommand({ tabId }, 'Target.getTargetInfo')
      )
      const targetInfo = info?.targetInfo
      tab.state = 'connected'
      tab.targetId = String(targetInfo?.targetId || '').trim() || tab.targetId

      try {
        sendToRelay({
          method: 'forwardCDPEvent',
          params: {
            method: 'Target.attachedToTarget',
            params: {
              sessionId: tab.sessionId,
              targetInfo: { ...targetInfo, attached: true },
              waitingForDebugger: false,
            },
          },
        })
      } catch {
        // WS might be down — scheduleReconnect will handle it
      }

      setBadge(tabId, 'on')
      void chrome.action.setTitle({
        tabId,
        title: 'Artífice Connect: attached (click to detach)',
      })
      void persistState()
      console.log(`[Artífice Relay] Tab ${tabId} re-attached after navigation (attempt ${attempt + 1})`)
      return
    } catch (err) {
      console.log(`[Artífice Relay] Tab ${tabId} re-attach attempt ${attempt + 1} failed: ${err}`)
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1000))
    }
  }

  console.warn(`[Artífice Relay] Tab ${tabId} re-attach failed after 3 attempts — giving up`)
  cleanupTab(tabId)
}

// ===== FIX #4: Tab lifecycle cleanup =====
chrome.tabs.onRemoved.addListener((tabId) => {
  if (!tabs.has(tabId)) return
  console.log(`[Artífice Relay] Tab ${tabId} closed — cleaning up`)
  void detachTab(tabId, 'tab_closed')
})

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  if (!tabs.has(removedTabId)) return
  console.log(`[Artífice Relay] Tab ${removedTabId} replaced by ${addedTabId} — cleaning up`)
  void detachTab(removedTabId, 'tab_replaced')
})

chrome.action.onClicked.addListener(() => void connectOrToggleForActiveTab())

chrome.runtime.onInstalled.addListener(() => {
  void chrome.runtime.openOptionsPage()
})

// ===== FIX #5: Keepalive via chrome.alarms =====
chrome.alarms.create('relay-keepalive', { periodInMinutes: 4 })

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'relay-keepalive') return
  if (tabs.size === 0) return
  console.log(`[Artífice Relay] Keepalive ping — ${tabs.size} tab(s) attached`)

  for (const [tabId, tab] of tabs.entries()) {
    if (tab.state !== 'connected') continue
    try {
      await chrome.debugger.sendCommand({ tabId }, 'Runtime.evaluate', {
        expression: '"keepalive"',
        returnByValue: true,
      })
    } catch {
      console.warn(`[Artífice Relay] Keepalive: tab ${tabId} debugger lost — cleaning up`)
      cleanupTab(tabId)
    }
  }
})

// ===== FIX #3: Restore state on service worker startup =====
void restoreState().then((restored) => {
  if (restored) {
    console.log('[Artífice Relay] Service worker restarted — state restored from session storage')
  }
})
