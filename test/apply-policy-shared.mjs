/**
 * Integration test: the plugin drives the HARNESS's own proxy policy.
 *
 * DSH ≥ 0.1.5 ships `@deepseek-ai/dsh-http-proxy`, whose module-level `active`
 * policy is what `proxyRouteFor(url)` answers from — and `web_fetch` is the one
 * provider that routes exclusively through that answer. This test mounts the
 * real plugin and asserts that a settings write flips BOTH the process-global
 * dispatcher AND `proxyRouteFor(url).proxied` for the very same module instance
 * the harness launcher would have loaded.
 *
 * Run: `node test/apply-policy-shared.mjs`
 *   needs `@deepseek-ai/cordis` + `@deepseek-ai/dsh-http-proxy` resolvable from
 *   the package (junctions into a DSH install, or a real DSH checkout).
 *   When `@deepseek-ai/dsh-http-proxy` is absent the test SKIPS: the plugin is
 *   expected to degrade to the legacy `EnvHttpProxyAgent` path there.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { getGlobalDispatcher, setGlobalDispatcher } from 'undici'
import * as plugin from '../lib/index.js'

const PROXY_ENV = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']

function saveEnv() {
  const saved = {}
  for (const key of PROXY_ENV) saved[key] = process.env[key]
  return saved
}

function restoreEnv(saved) {
  for (const key of PROXY_ENV) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
}

/** Resolve the official policy module the same way the plugin does. */
function resolveOfficialPolicyEntry() {
  try {
    return createRequire(import.meta.url).resolve('@deepseek-ai/dsh-http-proxy')
  } catch {
    return undefined
  }
}

/**
 * A settings provider shaped like the dsh-settings service face: register()
 * returns a scope whose update() notifies watchers, plus the namespace-level
 * update(ns, patch) the plugin's proxy_set tool uses.
 */
function createSettingsStub() {
  const registrations = new Map()
  const commit = (entry, patch) => {
    entry.user = { ...entry.user, ...patch }
    entry.revision += 1
    const previous = entry.resolved
    entry.resolved = entry.schema({ ...entry.base, ...entry.user })
    for (const watcher of [...entry.watchers]) watcher(entry.resolved, previous)
  }
  return {
    register(ns, schema, options = {}) {
      const entry = {
        schema,
        base: options.base,
        resolved: schema(options.base ?? {}),
        watchers: new Set(),
        user: {},
        revision: 0,
      }
      registrations.set(ns, entry)
      return {
        get: () => entry.resolved,
        watch: (callback) => {
          entry.watchers.add(callback)
          return () => entry.watchers.delete(callback)
        },
        update: (patch) => commit(entry, patch),
        replace: (section) => {
          entry.user = section
          entry.revision += 1
          entry.resolved = entry.schema({ ...entry.base, ...entry.user })
          for (const watcher of [...entry.watchers]) watcher(entry.resolved, undefined)
        },
      }
    },
    get: (ns) => registrations.get(ns)?.resolved,
    /**
     * The registration entry the plugin actually calls (DSH ≥ 0.1.2-rc.1 moved
     * it from a module export onto the SettingsProvider instance). Mirrors the
     * provider contract: register with the composition entry as base, expose the
     * scoped reader, notify on every resolved change.
     */
    installSection(owner, ns, schema, entry, hooks) {
      const scope = this.register(ns, schema, { base: entry })
      hooks.setSource(() => scope.get())
      scope.watch(() => hooks.onChange())
      hooks.onChange()
    },
    update(ns, patch) {
      const entry = registrations.get(ns)
      if (entry === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      return commit(entry, patch)
    },
    describe: () => [...registrations.entries()].map(([ns, entry]) => ({ ns, value: entry.resolved })),
  }
}

function createStubs() {
  const tools = []
  const sections = []
  const settings = createSettingsStub()
  return {
    settings,
    tools,
    sections,
    services: {
      tools: { register: (tool) => { tools.push(tool) } },
      systemPrompt: { section: (section) => { sections.push(section) } },
      settings,
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 80))

const entry = resolveOfficialPolicyEntry()

test('a settings write flips proxyRouteFor() through the harness policy module', { skip: entry === undefined ? 'requires @deepseek-ai/dsh-http-proxy' : false }, async () => {
  const { proxyRouteFor } = await import(pathToFileURL(entry).href)

  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const stubs = createStubs()
  const ctx = new Context()
  for (const [serviceName, value] of Object.entries(stubs.services)) ctx.provide(serviceName, value)

  const proxied = (url) => proxyRouteFor(new URL(url)).proxied

  try {
    assert.equal(proxied('https://example.com/'), false, 'policy starts on DIRECT')

    const fiber = ctx.plugin(plugin, plugin.Config({}))
    await fiber
    await settle()

    // Disabled by default: the harness policy must stay DIRECT.
    assert.equal(proxied('https://example.com/'), false, 'disabled plugin leaves the policy direct')

    // Enable through the same write path the GUI card and proxy_set use.
    await stubs.settings.update('proxy', { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()

    assert.equal(proxied('https://example.com/'), true, 'enabled plugin must install the harness policy')
    assert.equal(proxied('https://raw.githubusercontent.com/x'), true, 'blocked hosts must be proxied')
    assert.equal(proxied('http://127.0.0.1:3080/'), false, 'loopback must stay direct')
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890', 'child env still carries the proxy')
    assert.notEqual(getGlobalDispatcher(), defaultDispatcher, 'global dispatcher swapped while enabled')

    // The proxied arm must hand back a dispatcher: that is what web_fetch uses.
    const route = proxyRouteFor(new URL('https://example.com/'))
    assert.ok(route.proxied && route.dispatcher, 'a proxied route must expose its dispatcher')

    // Disable: the harness policy must return to DIRECT and the env be restored.
    await stubs.settings.update('proxy', { enabled: false })
    await settle()
    assert.equal(proxied('https://example.com/'), false, 'disabling must restore the DIRECT policy')
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)

    // Unload while enabled must not leak an installed policy.
    await stubs.settings.update('proxy', { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()
    assert.equal(proxied('https://example.com/'), true)
    fiber.dispose()
    await fiber
    await settle()
    assert.equal(proxied('https://example.com/'), false, 'unload must dispose the installed policy')
    assert.equal(getGlobalDispatcher(), defaultDispatcher)
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})
