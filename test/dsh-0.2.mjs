/** Optional validation against a separately built DSH 0.2 source installation. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const source = process.env.DSH_TEST_SOURCE
if (source) {
  const packages = new Map()
  function scan(dir, depth) {
    const manifest = join(dir, 'package.json')
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
      if (pkg.name?.startsWith('@deepseek-ai/')) packages.set(pkg.name, pathToFileURL(manifest).href)
    }
    if (depth) for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && !['node_modules', '.git'].includes(entry.name)) scan(join(dir, entry.name), depth - 1)
    }
  }
  for (const sub of ['vendor', 'packages', 'native']) scan(join(source, sub), 2)
  registerHooks({ resolve(specifier, context, next) {
    const pkg = specifier.split('/').slice(0, 2).join('/')
    return next(specifier, packages.has(pkg) ? { ...context, parentURL: packages.get(pkg) } : context)
  } })
}

for (const [name, field, nextValue] of [
  ['dsh-service-watchdog', 'watchdogPort', 3299],
  ['dsh-cost-panel', 'refreshSeconds', 120],
  ['dsh-plugin-proxy', 'enabled', true],
]) {
  test(`${name} retains its fiber and refreshes config on real DSH 0.2 Loader updates`, { skip: !source }, async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
    const plugin = await import(new URL(`../../${name}/lib/index.js`, import.meta.url))
    const compat = await import(new URL(`../../${name}/lib/settings-compat.js`, import.meta.url))
    const ctx = new Context()
    ctx.provide('settings', { configure: () => () => {} })
    let current, notifications = 0
    const Probe = { Config: plugin.Config, apply(child, config) {
      compat.installSettingsSection(child, 'probe', plugin.Config, config, {
        setSource: read => { current = read }, onChange: () => { notifications++ },
      })
    } }
    try {
      await ctx.plugin(Loader)
      ctx.loader.builtins.probe = Probe
      await ctx.loader.root.update([{ id: 'probe', name: 'cordis:probe', config: {} }])
      await ctx.loader.await()
      const entry = ctx.loader.resolve('probe'), fiber = entry.fiber
      assert.ok(fiber)
      const before = current()
      await ctx.loader.update('probe', { config: { ...before, [field]: nextValue } })
      await ctx.loader.await()
      assert.equal(ctx.loader.resolve('probe').fiber, fiber)
      assert.equal(current()[field], nextValue)
      assert.equal(notifications, 1)
      if (field === 'enabled') {
        await ctx.loader.update('probe', { config: { ...before, mode: 'invalid' } })
        await ctx.loader.await()
        assert.equal(current().mode, before.mode)
        assert.equal(current()[field], nextValue)
      }
    } finally { await ctx.fiber.dispose() }
  })
}

test('proxy applies and restores routing through the real DSH 0.2 plugin lifecycle', { skip: !source }, async () => {
  const { Context } = await import('@deepseek-ai/cordis')
  const { default: Loader } = await import('@deepseek-ai/cordis-plugin-loader')
  const { getGlobalDispatcher } = await import('undici')
  const plugin = await import('../lib/index.js')
  const ctx = new Context(), tools = [], sections = []
  const previousProxy = process.env.HTTP_PROXY, dispatcher = getGlobalDispatcher()
  ctx.provide('tools', { register: tool => { tools.push(tool) } })
  ctx.provide('systemPrompt', { section: section => { sections.push(section) } })
  ctx.provide('settings', {
    configure: () => () => {},
    update: async (id, patch) => {
      const entry = ctx.loader.resolve(id)
      await ctx.loader.update(id, { config: { ...entry.options.config, ...patch } })
    },
  })
  try {
    await ctx.plugin(Loader)
    ctx.loader.builtins.proxy = plugin
    await ctx.loader.root.update([{ id: 'proxy', name: 'cordis:proxy', config: { mode: 'custom', customUrl: 'http://127.0.0.1:18999', systemPollMs: 0 } }])
    await ctx.loader.await()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.equal(tools.length, 2)
    assert.equal(sections.length, 1)
    await tools.find(tool => tool.name === 'proxy_set').execute({ enabled: true })
    assert.equal(process.env.HTTP_PROXY, 'http://127.0.0.1:18999')
    assert.notEqual(getGlobalDispatcher(), dispatcher)
    await tools.find(tool => tool.name === 'proxy_set').execute({ enabled: false })
    assert.equal(process.env.HTTP_PROXY, previousProxy)
    assert.equal(getGlobalDispatcher(), dispatcher)
  } finally { await ctx.fiber.dispose() }
  assert.equal(process.env.HTTP_PROXY, previousProxy)
  assert.equal(getGlobalDispatcher(), dispatcher)
})

for (const [name, expected] of [
  ['dsh-cost-panel', ['sidebar.footer.action', 'shell.overlay', 'settings.plugins.tab']],
  ['dsh-service-watchdog', ['sidebar.footer.action', 'settings.plugins.tab']],
  ['dsh-plugin-proxy', ['sidebar.footer.action', 'settings.plugins.tab']],
  ['dsh-session-id', ['conversation.session.header.utilities']],
  ['dsh-session-memo', ['conversation.session.header.actions', 'shell.overlay']],
  ['dsh-session-status', ['conversation.session.header.utilities', 'settings.section']],
]) {
  test(`${name} registers and unloads its client through DSH 0.2 SlotRegistry`, { skip: !source }, async () => {
    const { Context } = await import('@deepseek-ai/cordis')
    const { SlotRegistry } = await import(pathToFileURL(join(source, 'packages/client/ui-renderer/lib/types/client/registry.js')))
    const { createElement } = await import('react')
    const ctx = new Context()
    new SlotRegistry(ctx)
    const keys = ['sidebar.footer.action', 'shell.overlay', 'settings.plugins.tab', 'settings.section',
      'conversation.session.header.utilities', 'conversation.session.header.actions']
    ctx.slots.register({ name: 'root', children: Object.fromEntries(keys.map(key => [key, {
      kind: 'list', scope: key.startsWith('conversation.') ? 'session' : 'root',
    }])) }, () => null)
    let subscriptions = 0, observers = 0
    const subscribe = () => { subscriptions++; return () => { subscriptions-- } }
    ctx.provide('configForms', { get: () => ({ subscribe, getSnapshot: () => ({ status: 'ready', value: {} }) }) })
    ctx.provide('sessions', { list: { subscribe, getSnapshot: () => ({ phase: 'ready', ids: [], byId: {} }) } })
    let client
    vm.runInNewContext(readFileSync(new URL(`../../${name}/lib/client.js`, import.meta.url), 'utf8'), {
      window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => ({ createElement })) } } },
      document: { readyState: 'complete', body: {}, querySelector: () => ({}), querySelectorAll: () => [] },
      MutationObserver: function () { return { observe() { observers++ }, disconnect() { observers-- } } },
      requestAnimationFrame: () => 1, cancelAnimationFrame() {},
    })
    try {
      const fiber = await ctx.plugin(client)
      await new Promise(resolve => setImmediate(resolve))
      for (const key of keys) assert.equal(ctx.slots.entries(key).length, expected.includes(key) ? 1 : 0, key)
      await fiber.dispose()
      for (const key of keys) assert.equal(ctx.slots.entries(key).length, 0, `unloaded ${key}`)
      assert.equal(subscriptions, 0, 'all store subscriptions removed')
      assert.equal(observers, 0, 'all DOM observers removed')
    } finally { await ctx.fiber.dispose() }
  })
}
