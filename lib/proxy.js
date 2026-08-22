/**
 * dsh-plugin-proxy — pure proxy-resolution logic.
 *
 * Everything in this module is dependency-free (no DSH/Cordis imports) so it
 * can be unit-tested in isolation. It covers:
 *
 * - `parseProxyServer` — parse a Windows Internet Settings `ProxyServer`
 *   string into http/https proxy URLs.
 * - `resolveProxyState` — decide the effective proxy from the plugin
 *   configuration plus (for `mode: 'system'`) the live system proxy facts.
 * - `composeNoProxy` — build the NO_PROXY bypass list from the configured
 *   entries (mapping the Windows `<local>` token).
 * - `makeWindowsSystemProxyReader` — read the Windows user proxy settings
 *   through `reg.exe` (the runner is injectable for tests).
 *
 * @module dsh-plugin-proxy/proxy
 */

const PROXY_REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** Bypass entries always present: the local machine and IPv6 loopback. */
const LOCAL_ENTRIES = ['localhost', '127.0.0.1', '::1']

/**
 * Turn a bare `host:port` (or already-schemed URL) into an `http://` proxy
 * URL string, or null when it is not usable.
 * @param value - the proxy address as typed in settings.
 * @returns normalized proxy URL, or null.
 */
export function normalizeProxyUrl(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  let url
  try {
    url = new URL(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed) ? trimmed : `http://${trimmed}`)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  if (!url.hostname) return null
  return url.toString().replace(/\/$/, '')
}

/**
 * Parse a Windows `ProxyServer` string. Accepts the single `host:port` form
 * (applies to both http and https) and the per-protocol
 * `http=host1:port;https=host2:port` form. `socks=...` entries are ignored
 * (undici's proxy agents speak HTTP CONNECT only); a malformed entry that
 * must contribute yields null.
 * @param value - the raw registry value.
 * @returns `{ http, https }` URL strings, or null when nothing usable.
 */
export function parseProxyServer(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (trimmed.length === 0) return null
  const parts = trimmed.split(';').map(part => part.trim()).filter(Boolean)
  const out = {}
  let usable = false
  for (const part of parts) {
    const eq = part.indexOf('=')
    if (eq === -1) {
      // Bare host:port — one proxy for both protocols.
      const url = normalizeProxyUrl(part)
      if (url === null) return null
      out.http = url
      out.https = url
      usable = true
      continue
    }
    const protocol = part.slice(0, eq).trim().toLowerCase()
    const target = part.slice(eq + 1).trim()
    if (protocol !== 'http' && protocol !== 'https') continue
    const url = normalizeProxyUrl(target)
    if (url === null) return null
    out[protocol] = url
    usable = true
  }
  return usable ? out : null
}

/** Parse a `REG_DWORD` line like `    ProxyEnable    REG_DWORD    0x1`. */
export function parseRegDword(line) {
  if (typeof line !== 'string') return undefined
  const match = /REG_DWORD\s+0x([0-9a-fA-F]+)/.exec(line)
  if (match === null) return undefined
  return Number.parseInt(match[1], 16)
}

/** Parse a `REG_SZ` line like `    ProxyServer    REG_SZ    127.0.0.1:10808`. */
export function parseRegString(line) {
  if (typeof line !== 'string') return undefined
  const match = /REG_(?:SZ|EXPAND_SZ)\s+(.*)$/.exec(line)
  if (match === null) return undefined
  return match[1].trim()
}

/**
 * Decode one `reg query` invocation's combined stdout into the raw
 * ProxyEnable / ProxyServer / ProxyOverride facts (or a best-effort empty
 * shape when the query failed — a missing value means "no system proxy").
 * @param stdout - the `reg query` stdout for one value.
 * @returns the raw fact, or null when the query errored.
 */
export function queryRegValue(stdout) {
  if (typeof stdout !== 'string') return null
  const match = /REG_(?:DWORD|SZ|EXPAND_SZ)\s+(.*)$/.exec(stdout.trim())
  if (match === null) return null
  return match[1].trim()
}

/**
 * Build a system-proxy reader for Windows: three `reg.exe` queries resolved
 * into `{ enabled, http, https, url, override }`. The `execFile` runner is
 * injected so tests can substitute a fake.
 * @param execFile - `(file, args, options) => Promise<{ stdout, stderr }>`.
 * @returns an async function returning the system proxy facts.
 */
export function makeWindowsSystemProxyReader(execFile) {
  const query = async (valueName) => {
    try {
      const result = await execFile('reg', ['query', PROXY_REG_KEY, '/v', valueName], {
        windowsHide: true,
        timeout: 3000,
      })
      const raw = queryRegValue(String(result.stdout ?? ''))
      if (raw === null) return undefined
      if (valueName === 'ProxyEnable') {
        return /^0x[0-9a-fA-F]+$/.test(raw) ? Number.parseInt(raw.slice(2), 16) : Number.parseInt(raw, 10)
      }
      return raw
    } catch {
      return undefined
    }
  }
  return async () => {
    const [enable, server, override] = await Promise.all([
      query('ProxyEnable'),
      query('ProxyServer'),
      query('ProxyOverride'),
    ])
    const enabled = typeof enable === 'number' && enable === 1
    const parsed = parseProxyServer(typeof server === 'string' ? server : '')
    return {
      enabled,
      http: enabled ? (parsed?.http ?? null) : null,
      https: enabled ? (parsed?.https ?? null) : null,
      url: enabled ? (parsed?.http ?? parsed?.https ?? null) : null,
      override: typeof override === 'string' ? override : '',
    }
  }
}

/**
 * Merge the configured NO_PROXY entries with the always-present local
 * entries and (optionally) the Windows ProxyOverride list. The `<local>`
 * token is mapped to the loopback addresses; entries are deduplicated in
 * order.
 * @param configured - comma-separated bypass list from settings.
 * @param override - optional Windows ProxyOverride string (system mode).
 * @returns the comma-separated NO_PROXY value to install.
 */
export function composeNoProxy(configured, override) {
  const seen = new Set()
  const out = []
  const push = (entry) => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    out.push(entry)
  }
  for (const entry of LOCAL_ENTRIES) push(entry)
  const raw = typeof configured === 'string' ? configured : ''
  for (const part of raw.split(',')) {
    const entry = part.trim()
    if (entry.length === 0) continue
    if (entry === '<local>') {
      for (const local of LOCAL_ENTRIES) push(local)
      continue
    }
    push(entry)
  }
  if (typeof override === 'string' && override.trim().length > 0) {
    for (const entry of parseOverrideEntries(override)) push(entry)
  }
  return out.join(',')
}

/**
 * Parse a Windows `ProxyOverride` string into NO_PROXY entries undici can
 * honor. Windows uses `;` separators, `<local>` for the intranet bypass, and
 * may carry IP-prefix wildcards (`127.*`, `10.*`, `192.168.*`) that undici's
 * NO_PROXY matcher cannot represent (it matches exact hosts, `*.domain`
 * subdomains, and `host:port` only) — those are dropped rather than shipped
 * as dead entries.
 * @param override - the raw `ProxyOverride` registry value.
 * @returns usable NO_PROXY entries (deduplicated, in order).
 */
export function parseOverrideEntries(override) {
  const out = []
  const seen = new Set()
  const push = (entry) => {
    if (entry.length === 0 || seen.has(entry)) return
    seen.add(entry)
    out.push(entry)
  }
  if (typeof override !== 'string') return out
  const parts = override.split(/[;,]/).map((part) => part.trim()).filter(Boolean)
  for (const part of parts) {
    if (part === '<local>') {
      for (const local of LOCAL_ENTRIES) push(local)
      continue
    }
    // Accept exact hosts/IPs, `*.domain` / `.domain` subdomains, and
    // `host:port`. Drop IP-prefix wildcards and bare `*` (not representable).
    if (part.includes('*') && !/^\*?\.[^.*]/.test(part)) continue
    if (/^\*\./.test(part)) { push(part); continue }
    push(part)
  }
  return out
}

/** Compare two system-proxy fact sets (for poll de-duplication). */
export function systemFactsEqual(a, b) {
  if (a === b) return true
  if (a === null || b === null) return false
  return a.enabled === b.enabled
    && (a.url ?? null) === (b.url ?? null)
    && (a.override ?? '') === (b.override ?? '')
}

/**
 * Decide the effective proxy state from the plugin configuration and the
 * system proxy facts. Pure: the caller is responsible for fetching the system
 * facts when `mode` is `system`.
 * @param config - resolved plugin configuration
 *   `{ enabled, mode, customUrl, noProxy }`.
 * @param systemProxy - `{ enabled, url }` facts (only consulted for
 *   `mode: 'system'`).
 * @returns `{ active, url, http, https, noProxy, reason }`.
 */
export function resolveProxyState(config, systemProxy) {
  const enabled = config?.enabled === true
  const mode = config?.mode ?? 'none'
  const noProxy = composeNoProxy(config?.noProxy)
  if (!enabled) {
    return { active: false, url: null, http: null, https: null, noProxy, reason: 'disabled' }
  }
  if (mode === 'none') {
    return { active: false, url: null, http: null, https: null, noProxy, reason: 'mode-none' }
  }
  if (mode === 'custom') {
    const url = normalizeProxyUrl(config?.customUrl)
    if (url === null) {
      return { active: false, url: null, http: null, https: null, noProxy, reason: 'invalid-custom-url' }
    }
    return { active: true, url, http: url, https: url, noProxy, reason: 'custom' }
  }
  // mode === 'system'
  if (systemProxy?.enabled !== true || systemProxy.url === null) {
    return { active: false, url: null, http: null, https: null, noProxy, reason: 'system-proxy-off' }
  }
  return {
    active: true,
    url: systemProxy.url,
    http: systemProxy.http ?? systemProxy.url,
    https: systemProxy.https ?? systemProxy.url,
    // Merge the Windows ProxyOverride bypass list into NO_PROXY for system
    // mode, so intranet hosts Windows already exempts stay direct.
    noProxy: composeNoProxy(config?.noProxy, systemProxy.override),
    reason: 'system',
  }
}
