/**
 * Integration test: mount the real plugin on a Cordis root context with stub
 * services (tools / systemPrompt / settings) and prove the live proxy
 * behavior — settings writes toggle the process env and the global dispatcher.
 *
 * Run: `node test/apply.mjs` (needs the @deepseek-ai junctions + undici).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import { setGlobalDispatcher, getGlobalDispatcher } from 'undici'
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

/**
 * In-memory settings provider shaped like the dsh-settings service face:
 * register(ns, schema, opts) -> scope { get, watch, update }, plus the
 * namespace-level update(ns, patch) the plugin's proxy_set tool calls and the
 * describe() the settings UIs read.
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
  const service = {
    register(ns, schema, options = {}) {
      if (registrations.has(ns)) throw new Error(`duplicate namespace ${ns}`)
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
    get(ns) {
      return registrations.get(ns)?.resolved
    },
    update(ns, patch) {
      const entry = registrations.get(ns)
      if (entry === undefined) throw new Error(`settings namespace "${ns}" is not registered`)
      return commit(entry, patch)
    },
    describe() {
      return [...registrations.entries()].map(([ns, entry]) => ({
        ns,
        schema: entry.schema.toJSON(),
        value: entry.resolved,
        revision: entry.revision,
        base: entry.base,
        applies: 'live',
      }))
    },
  }
  return service
}

/** Stub services the plugin injects, plus captured registrations. */
function createStubs() {
  const tools = []
  const sections = []
  const settings = createSettingsStub()
  return {
    settings,
    tools,
    sections,
    services: {
      tools: {
        register: (tool) => { tools.push(tool) },
      },
      systemPrompt: {
        section: (section) => { sections.push(section) },
      },
      settings,
    },
  }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50))

test('apply() wires settings, tools, prompt section, and live proxy toggling', async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const stubs = createStubs()
  const ctx = new Context()
  for (const [serviceName, value] of Object.entries(stubs.services)) {
    ctx.provide(serviceName, value)
  }
  try {
    const fiber = ctx.plugin(plugin, plugin.Config({}))
    await fiber
    await settle()

    // Settings namespace registered with the composition entry as base.
    const descriptors = stubs.settings.describe()
    const proxyNs = descriptors.find((descriptor) => descriptor.ns === 'proxy')
    assert.ok(proxyNs, 'proxy namespace must be registered')
    assert.equal(proxyNs.value.enabled, false)

    // Tools registered.
    const toolNames = stubs.tools.map((tool) => tool.name)
    assert.ok(toolNames.includes('proxy_status'))
    assert.ok(toolNames.includes('proxy_set'))

    // Dynamic system-prompt section registered.
    assert.equal(stubs.sections.length, 1)
    assert.equal(stubs.sections[0].name, 'proxy:status')
    assert.equal(typeof stubs.sections[0].text, 'function')

    // Default (disabled): env untouched, dispatcher unchanged.
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher)

    // Enable via the settings write path (what the UI / proxy_set does).
    await stubs.settings.update('proxy', { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()

    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')
    assert.equal(process.env.NO_PROXY, 'localhost,127.0.0.1,::1')
    assert.notEqual(getGlobalDispatcher(), defaultDispatcher, 'global dispatcher must be swapped while enabled')

    // Disable again → env restored, dispatcher restored.
    await stubs.settings.update('proxy', { enabled: false })
    await settle()
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher, 'global dispatcher must be restored when disabled')

    // Plugin unload restores everything even if left enabled.
    await stubs.settings.update('proxy', { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890' })
    await settle()
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:7890')
    fiber.dispose()
    await fiber
    assert.equal(process.env.HTTP_PROXY, savedEnv.HTTP_PROXY)
    assert.equal(getGlobalDispatcher(), defaultDispatcher)
  } finally {
    restoreEnv(savedEnv)
    setGlobalDispatcher(defaultDispatcher)
  }
})
