/**
 * dsh-plugin-proxy — server half (Cordis plugin).
 *
 * Routes the whole DSH host process through a proxy when enabled:
 *
 * - **Model requests** — the LLM adapters call global `fetch()`, so routing the
 *   process-global dispatcher through the proxy covers every model request
 *   (chat completions, SSE streaming, web search providers) through the proxy.
 * - **`web_fetch`** — that provider owns a private undici transport and routes
 *   only through the DSH host's own proxy policy (`proxyRouteFor`), so this
 *   plugin installs that official policy by reusing the very module instance
 *   the harness launcher already loaded (`@deepseek-ai/dsh-http-proxy`). The
 *   GUI switch therefore drives `proxyRouteFor(url).proxied` too. When that
 *   module cannot be resolved, the plugin degrades to the legacy
 *   `EnvHttpProxyAgent` dispatcher, which does not reach `web_fetch`.
 * - **Agent subprocesses** — `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`
 *   are written into `process.env`, which the harness's scrubbed child env
 *   inherits, so `curl`, `git`, `npm`, `pwsh`-spawned tools and any other
 *   child CLI honor the same proxy and the same bypass list.
 * - **Agent awareness** — a dynamic system-prompt section always states the
 *   current proxy state (on/off, effective address, bypass list), plus two
 *   model tools: `proxy_status` (read) and `proxy_set` (toggle). The agent can
 *   therefore never silently operate through a proxy it does not know about,
 *   and can turn the proxy off for operations that must go direct, then back
 *   on.
 *
 * Configuration lives in the `proxy` settings namespace (Settings → Plugins →
 * Proxy in the web UI) layered over the composition entry; every change is
 * applied live (`applies: live`), no restart required.
 *
 * @module dsh-plugin-proxy
 */
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
// installSettingsSection / settingsNamespace removed in DSH ≥0.1.2-rc.1;
// installSection is now a method on the SettingsProvider instance (ctx.settings).
import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { promisify } from 'node:util'
import { pathToFileURL } from 'node:url'
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import {
  composeNoProxy,
  makeWindowsSystemProxyReader,
  resolveProxyState,
  systemFactsEqual,
} from './proxy.js'

const execFileAsync = promisify(execFile)

/** Cordis plugin name. */
const name = 'proxy'

/** Services this plugin must resolve before it applies. */
const inject = ['tools', 'systemPrompt', 'settings']

/** Settings namespace owning the proxy configuration. */
const PROXY_NS = 'proxy'

/** Environment names this plugin owns (saved at load, restored on disable/unload). */
const PROXY_ENV = [
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

/** Composition-row configuration (also the settings schema). */
const Config = z.object({
  /** Master switch: route the host through the configured proxy when true. */
  enabled: z.boolean().default(false),
  /**
   * Where the proxy address comes from: `system` = the Windows user proxy
   * (Internet Settings), `custom` = `customUrl`, `none` = never proxy even
   * when the switch is on.
   */
  mode: z.union([z.const('system'), z.const('custom'), z.const('none')]).default('system'),
  /** Custom proxy address, e.g. `http://127.0.0.1:7890`. */
  customUrl: z.string().default('http://127.0.0.1:7890'),
  /** Comma-separated NO_PROXY bypass hosts; `<local>` maps to the loopbacks. */
  noProxy: z.string().default('localhost,127.0.0.1,::1'),
  /**
   * Poll interval (ms) for the Windows system proxy when `mode: 'system'` and
   * the switch is on: lets the plugin follow the system proxy being toggled on
   * or off (proxy software like Clash/v2rayN) without a settings change.
   * `0` disables polling (system proxy read once per change).
   */
  systemPollMs: z.number().default(30000).min(0),
})

/** Default dispatcher captured at load — restoring it disables proxying. */
function captureDefaultDispatcher() {
  try {
    return getGlobalDispatcher()
  } catch {
    return undefined
  }
}

/** Ordered placement of the proxy status section in the system prompt. */
const SECTION_ORDER = 55

/**
 * Lazily resolved `@deepseek-ai/dsh-http-proxy` entry — the SAME physical
 * module instance the harness launcher installed its policy with, so the
 * `active` policy this plugin installs is the one `proxyRouteFor()` reads.
 */
let dshProxyEntry
let dshProxyLookupAttempted = false

/**
 * Disposer of the policy currently installed through the official installer.
 * Cleared on every dispose so the next sync installs a fresh policy.
 */
let disposeDshProxy

/**
 * Resolve the official proxy module entry, preferring the harness launcher's
 * own resolution base so both import the identical file (Node caches ESM by
 * resolved URL, which is what makes the shared `active` policy possible).
 * @returns the resolved `lib/index.js` path, or undefined when unavailable.
 */
function resolveDshHttpProxyEntry() {
  if (dshProxyLookupAttempted) return dshProxyEntry
  dshProxyLookupAttempted = true
  const bases = []
  try {
    if (typeof process.argv[1] === 'string' && process.argv[1].length > 0) bases.push(process.argv[1])
  } catch {
    // No usable launcher argv; the plugin's own location is the next base.
  }
  bases.push(import.meta.url)
  for (const base of bases) {
    try {
      dshProxyEntry = createRequire(base).resolve('@deepseek-ai/dsh-http-proxy')
      return dshProxyEntry
    } catch {
      // Try the next resolution base; without a hit the legacy path is used.
    }
  }
  return undefined
}

/**
 * Build the EnvLookup the official resolver expects: a name for which it
 * returns `{ value }`, or `undefined` when the name is unset. A fresh view per
 * install keeps this plugin independent of whatever the surrounding process
 * environment happened to contain.
 * @param proxyEnv - resolved uppercase proxy values.
 * @returns the lookup handed to `installProxyFromEnvironment`.
 */
function createProxyEnvLookup(proxyEnv) {
  const table = {}
  for (const [key, value] of Object.entries(proxyEnv)) {
    if (value === undefined || value === null) continue
    table[key.toUpperCase()] = value
  }
  return {
    get(name) {
      const value = table[String(name).toUpperCase()]
      return value === undefined ? undefined : { value }
    },
  }
}

/**
 * Mirror the official installer's uppercase names onto the lowercase ones.
 * The harness passes both casings to children (POSIX case-sensitive readers
 * need the lowercase forms; Windows `process.env` is case-insensitive).
 * @param proxyEnv - the uppercase values just installed.
 */
function mirrorLowerCaseProxyEnv(proxyEnv) {
  for (const [key, value] of Object.entries(proxyEnv)) {
    if (value === undefined) continue
    process.env[key.toLowerCase()] = value
  }
}

/** Restore the load-time environment for every proxy name this plugin owns. */
function restoreProxyEnvironment(savedEnv) {
  for (const key of PROXY_ENV) {
    const saved = savedEnv[key]
    if (saved === undefined) delete process.env[key]
    else process.env[key] = saved
  }
}

/**
 * Dispose the policy this plugin installed through the official installer, so
 * the host falls back to its previous (direct) policy.
 * @returns a promise that settles once the policy is restored.
 */
async function disposeInstalledDshProxy() {
  const dispose = disposeDshProxy
  if (dispose === undefined) return
  disposeDshProxy = undefined
  try {
    await dispose()
  } catch {
    // Restoration is best-effort: a failed dispose must not wedge the switch.
  }
}

/** Build the agent-facing status text from the latest sync snapshot. */
function renderStatusText(snapshot) {
  const effective = snapshot?.effective
  const config = snapshot?.config
  if (effective === undefined || config === undefined) {
    return 'Proxy: not yet initialized.'
  }
  const active = effective.active === true
  const mode = config.mode ?? 'none'
  const modeLabel = mode === 'system' ? 'Windows system proxy' : mode === 'custom' ? 'custom address' : 'disabled by mode'
  if (!active) {
    const reason = effective.reason === 'system-proxy-off'
      ? 'the Windows system proxy is currently off'
      : effective.reason === 'invalid-custom-url'
        ? 'the custom proxy address is invalid'
        : effective.reason === 'mode-none'
          ? 'the mode is set to "none"'
          : 'the proxy switch is off'
    return [
      '## Proxy status: OFF',
      '',
      `Network traffic currently goes DIRECT (no proxy): ${reason}.`,
      'If a network operation fails and you suspect it needs a proxy, call `proxy_status` to confirm, then `proxy_set` with enabled=true — or ask the user to flip the proxy switch.',
    ].join('\n')
  }
  const source = mode === 'system' ? 'Windows system proxy' : 'custom address'
  return [
    '## Proxy status: ON',
    '',
    `The whole runtime (model requests, web_search/web_fetch, and all spawned tools) is routed through the proxy: ${effective.url} (${source}).`,
    '',
    `Bypass list (NO_PROXY, traffic goes direct): ${effective.noProxy || '(none)'}.`,
    '',
    'Implications you MUST respect:',
    '- Assume every outbound HTTP(S) request goes through this proxy unless the host is on the bypass list.',
    '- Localhost / 127.0.0.1 / ::1 and anything in the bypass list always go direct — use them for local services.',
    '- If an operation must NOT go through the proxy (an internal network target, a local server, a host the proxy would break), call `proxy_set` with enabled=false first, run the operation, then re-enable with enabled=true.',
    '- Do not silently retry failed proxy attempts with a different tool expecting a different route; check `proxy_status` and the failure reason first.',
  ].join('\n')
}

/** JSON-safe summary returned by the tools and the status event. */
function summarize(snapshot) {
  const effective = snapshot?.effective
  const config = snapshot?.config
  return {
    active: effective?.active === true,
    enabled: config?.enabled === true,
    mode: config?.mode ?? 'none',
    url: effective?.url ?? '',
    noProxy: effective?.noProxy ?? composeNoProxy(config?.noProxy),
    reason: effective?.reason ?? 'unknown',
    source: config?.mode === 'system' ? 'system' : config?.mode === 'custom' ? 'custom' : 'none',
    at: snapshot?.at ?? '',
  }
}

/**
 * Apply (or tear down) the proxy in the host process.
 *
 * When the official `@deepseek-ai/dsh-http-proxy` module resolves, the policy is
 * installed through `installProxyFromEnvironment`, which is the only route that
 * also reaches `web_fetch` (its private transport asks `proxyRouteFor`). The
 * returned disposer restores the previous policy — and, through the official
 * installer, the previous environment as well.
 *
 * @param effective - resolved proxy state from {@link resolveProxyState}.
 * @param savedEnv - the environment values captured at load.
 * @param currentDispatcher - the dispatcher installed by the previous apply.
 * @returns the dispatcher now installed (undefined when the policy owns it).
 */
async function applyEffective(effective, savedEnv, currentDispatcher) {
  if (effective.active === true && effective.url !== null) {
    const proxyEnv = {
      HTTP_PROXY: effective.http ?? effective.url,
      HTTPS_PROXY: effective.https ?? effective.url,
      ALL_PROXY: effective.url,
      NO_PROXY: effective.noProxy,
    }
    // Preferred: hand the GUI state to the harness's own policy installer, so
    // `proxyRouteFor(url).proxied` — and therefore web_fetch — follows it.
    const entry = resolveDshHttpProxyEntry()
    if (entry !== undefined) {
      try {
        const { installProxyFromEnvironment } = await import(pathToFileURL(entry).href)
        await disposeInstalledDshProxy()
        disposeDshProxy = await installProxyFromEnvironment(
          createProxyEnvLookup(proxyEnv),
          (message) => ctx.logger.warn('proxy: %s', message),
        )
        mirrorLowerCaseProxyEnv(proxyEnv)
        void Promise.resolve(currentDispatcher?.close?.()).catch(() => {})
        return undefined
      } catch (error) {
        ctx.logger.warn('proxy: official proxy policy could not be installed: %s', String(error))
      }
    }
    // Legacy fallback: the process-global dispatcher only, which leaves
    // web_fetch on whatever policy the host already had.
    const noProxy = effective.noProxy
    const fallbackEnv = { ...proxyEnv, NO_PROXY: noProxy }
    for (const key of PROXY_ENV) {
      const upper = key.toUpperCase()
      if (fallbackEnv[upper] !== undefined) process.env[key] = fallbackEnv[upper]
    }
    // EnvHttpProxyAgent reads the proxy env at construction and re-reads
    // NO_PROXY per request, so a fresh instance picks up the current env.
    const next = new EnvHttpProxyAgent()
    setGlobalDispatcher(next)
    void Promise.resolve(currentDispatcher?.close?.()).catch(() => {})
    return next
  }
  // Disable: restore the previous policy first, then the load-time environment
  // and dispatcher.
  await disposeInstalledDshProxy()
  restoreProxyEnvironment(savedEnv)
  if (savedEnv.dispatcher !== undefined) {
    setGlobalDispatcher(savedEnv.dispatcher)
  }
  void Promise.resolve(currentDispatcher?.close?.()).catch(() => {})
  return undefined
}

/**
 * Cordis plugin body.
 * @param ctx - registrant context (`tools`, `systemPrompt`, `settings`, ...).
 * @param config - validated composition configuration.
 */
function apply(ctx, config) {
  const savedEnv = { dispatcher: captureDefaultDispatcher() }
  for (const key of PROXY_ENV) {
    savedEnv[key] = process.env[key]
  }

  const systemProxyReader = makeWindowsSystemProxyReader(execFileAsync)
  let source = () => config
  let snapshot = undefined
  let dispatcher = undefined
  let syncing = null
  let disposed = false
  let pollTimer = undefined

  const sync = async () => {
    if (disposed) return
    const resolved = source()
    let systemProxy = null
    if (resolved.mode === 'system' && resolved.enabled === true) {
      try {
        systemProxy = await systemProxyReader()
      } catch (error) {
        ctx.logger.warn('proxy: reading the Windows system proxy failed: %s', String(error))
      }
    }
    const effective = resolveProxyState(resolved, systemProxy)
    try {
      // The official policy install may be asynchronous (dynamic import), so
      // every GUI change is awaited here before the status snapshot is taken.
      dispatcher = await applyEffective(effective, savedEnv, dispatcher)
    } catch (error) {
      ctx.logger.warn('proxy: applying the proxy failed: %s', String(error))
    }
    snapshot = { config: resolved, effective, systemProxy, at: new Date().toISOString() }
    ctx.emit('proxy/status', summarize(snapshot))
  }

  /** Coalesced sync: concurrent triggers share one in-flight pass. */
  const requestSync = () => {
    if (disposed) return Promise.resolve()
    if (syncing !== null) return syncing
    syncing = sync().finally(() => { syncing = null })
    return syncing
  }

  // Configuration source: the `proxy` settings namespace layered over the
  // composition entry (installSettingsSection registers it); falls back to the
  // entry when no settings service is mounted (headless compositions). Every
  // committed change re-syncs live (`applies: live`).
  ctx.settings.installSection(ctx, PROXY_NS, Config, config, {
    setSource: (current) => {
      source = current
      void requestSync()
    },
    onChange: () => {
      void requestSync()
    },
  })

  // Agent-visible status: read-only snapshot tool.
  ctx.tools.register(defineTool({
    name: 'proxy_status',
    description: 'Show the current proxy state of this runtime: whether traffic goes through a proxy, the effective proxy address, the NO_PROXY bypass list, and the source of the setting. Call this before any network operation where the proxy route matters, and whenever a network operation fails unexpectedly.',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          url: { type: 'string', required: true },
          noProxy: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          source: { type: 'string', required: true },
          at: { type: 'string', required: true },
        },
      },
      render: (_args, value) => {
        const head = value.active
          ? `Proxy ON — ${value.url} (${value.source === 'system' ? 'system' : 'custom'})`
          : `Proxy OFF — direct connection (${value.reason})`
        const lines = [head, `NO_PROXY bypass: ${value.noProxy || '(none)'}`]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    execute: async () => {
      await requestSync()
      return summarize(snapshot)
    },
    presentCall: () => ({
      card: 'generic',
      title: 'Proxy status',
      kind: 'other',
      rawInput: {},
    }),
  }))

  // Agent-visible control: toggle the proxy from the conversation.
  ctx.tools.register(defineTool({
    name: 'proxy_set',
    description: 'Turn the proxy on or off for the whole runtime. Use enabled=false when an operation must go DIRECT (an internal/intranet target, a local server, or a host the proxy would break), then re-enable with enabled=true afterwards. The change is persisted and takes effect immediately for model requests and spawned tools.',
    parameters: {
      enabled: {
        type: 'boolean',
        required: true,
        description: 'true = route traffic through the configured proxy; false = go direct (no proxy).',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          active: { type: 'boolean', required: true },
          enabled: { type: 'boolean', required: true },
          mode: { type: 'string', required: true },
          url: { type: 'string', required: true },
          noProxy: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          source: { type: 'string', required: true },
          at: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.active
          ? `Proxy enabled — ${value.url} (${value.source === 'system' ? 'system' : 'custom'})`
          : `Proxy disabled — traffic now goes direct.`,
      }],
    },
    execute: async (args) => {
      const settings = ctx.get('settings')
      if (settings === undefined) {
        throw new Error('proxy_set: the settings service is unavailable in this composition — change the proxy config instead')
      }
      await settings.update(PROXY_NS, { enabled: args.enabled === true })
      await requestSync()
      return summarize(snapshot)
    },
    presentCall: (args) => ({
      card: 'generic',
      title: `Proxy ${args.enabled === true ? 'on' : 'off'}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  // The model must always know whether the proxy is in force: a dynamic
  // section re-rendered at every system-prompt assembly.
  ctx.systemPrompt.section({
    name: 'proxy:status',
    order: SECTION_ORDER,
    text: () => renderStatusText(snapshot),
  })

  // Follow the Windows system proxy at runtime: when `mode: 'system'` and the
  // switch is on, re-read the registry on an interval and re-apply only when
  // the facts actually changed (toggling proxy software must not leave the
  // runtime pointed at a dead proxy). Cordis core has no managed timers, so
  // the interval is cleared in the teardown effect below.
  if (config.systemPollMs > 0) {
    pollTimer = setInterval(async () => {
      if (disposed) return
      const resolved = source()
      if (resolved.mode !== 'system' || resolved.enabled !== true) return
      let facts
      try {
        facts = await systemProxyReader()
      } catch {
        return
      }
      const previous = snapshot?.systemProxy ?? null
      if (previous !== null && systemFactsEqual(previous, facts)) return
      void requestSync()
    }, config.systemPollMs)
    pollTimer.unref?.()
  }

  // Tear down: hand the harness back its own policy and restore the load-time
  // environment and dispatcher when the plugin unloads.
  ctx.effect(() => {
    return () => {
      disposed = true
      if (pollTimer !== undefined) clearInterval(pollTimer)
      try {
        if (disposeDshProxy !== undefined) {
          // The official installer owns both the policy and the environment it
          // wrote, so its disposer is the complete restore path.
          void disposeInstalledDshProxy()
        } else {
          restoreProxyEnvironment(savedEnv)
          if (savedEnv.dispatcher !== undefined) {
            setGlobalDispatcher(savedEnv.dispatcher)
          }
          void Promise.resolve(dispatcher?.close?.()).catch(() => {})
        }
      } catch {
        // Best-effort restore; nothing sensible to do if it throws.
      }
    }
  }, 'proxy: cleanup')
}

export { Config, apply, inject, name }
