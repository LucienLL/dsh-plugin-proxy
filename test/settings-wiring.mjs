/**
 * Settings-wiring guard for the plugins that call `settings-compat.js`
 * (cost-panel, proxy, watchdog) plus the Config-volatility rule every plugin
 * with a Config must satisfy on DSH 0.2.
 *
 * DSH 0.2 derives settings pages from the profile entry instead of a
 * `register(ns, schema)` call, which imposes two silent requirements:
 *
 * - `SettingsForms.describe()` skips any entry whose `volatileForm(Config)` is
 *   empty, so a Config with no volatile field renders no settings page at all.
 * - The 0.1 helper `installSettingsSection` is gone. A plugin that still
 *   resolves an older `dsh-settings` keeps the helper, and running it against a
 *   0.2 service throws inside an injected callback — which the host swallows.
 *
 * Both were true of this tree before the 0.2.0-rc.2 pass: the schemas were
 * plain and the wiring came from a stale `dsh-settings`. These tests fail on
 * either regression without needing a running host.
 */
import test from 'node:test'
import assert from 'node:assert/strict'

/** Plugins whose browser half renders a custom settings card. */
const CONFIGURED = ['dsh-cost-panel', 'dsh-plugin-proxy', 'dsh-service-watchdog', 'dsh-session-memo', 'dsh-session-status']

/** Plugins that install their settings section through `settings-compat.js`. */
const COMPAT = ['dsh-cost-panel', 'dsh-plugin-proxy', 'dsh-service-watchdog']

const load = subpath => import(new URL(subpath, import.meta.url).href)

/** DSH 0.2's `volatileForm` rule, reduced to the yes/no this guard needs. */
function hasVolatileField(node) {
  if (node?.meta?.volatile === true) return true
  return Object.values(node?.dict ?? {}).some(hasVolatileField)
}

/** Minimal context standing in for the host plugin context. */
function harness(service) {
  const calls = []
  const child = {
    settings: service,
    effect(run) {
      calls.push(['effect'])
      return run()
    },
  }
  const ctx = {
    fiber: {},
    settings: service,
    on(event) { calls.push(['on', event]) },
    inject(dependencies, callback) {
      calls.push(['inject', dependencies.join(',')])
      callback(child)
    },
  }
  return { ctx, calls }
}

for (const name of CONFIGURED) {
  test(`${name}: Config carries a volatile field so DSH 0.2 publishes a settings page`, async () => {
    const plugin = await load(`../../${name}/lib/index.js`)
    assert.ok(plugin.Config, `${name} exports no Config`)
    assert.ok(hasVolatileField(plugin.Config), `${name} Config has no volatile field; describe() would skip it`)
  })
}

for (const name of COMPAT) {
  test(`${name}: settings wiring falls back when the host service has no register()`, async () => {
    const compat = await load(`../../${name}/lib/settings-compat.js`)
    const service = { configure(presentation) { this.calls.push(presentation); return () => {} }, calls: [] }
    const { ctx, calls } = harness(service)
    let source
    assert.doesNotThrow(() => {
      compat.installSettingsSection(ctx, 'probe', undefined, { field: { get: () => 7 } }, {
        setSource(read) { source = read },
        onChange() {},
      })
    }, `${name} threw while installing its settings section on a 0.2 host`)
    assert.deepEqual(service.calls, [{ auto: false }], `${name} did not switch presentation to a custom card`)
    assert.equal(source?.().field, 7, `${name} did not expose a live config source`)
    assert.ok(calls.some(([kind, value]) => kind === 'on' && value === 'loader/volatile-update'),
      `${name} does not follow runtime config updates`)
  })

  test(`${name}: settings wiring survives a host service that still exposes register()`, async () => {
    const compat = await load(`../../${name}/lib/settings-compat.js`)
    let registered = 0
    const service = {
      configure() { return () => {} },
      register() {
        registered += 1
        return { get: () => ({}), watch() {} }
      },
    }
    const { ctx } = harness(service)
    assert.doesNotThrow(() => {
      compat.installSettingsSection(ctx, 'probe', undefined, {}, { setSource() {}, onChange() {} })
    })
    assert.ok(registered <= 1)
  })
}
