/**
 * Manifest-level adaptation guard for the six self-maintained DSH plugins.
 *
 * `dsh-0.2.mjs` boots them against a built DSH source tree, which catches
 * runtime contract changes but says nothing about the two manifest contracts a
 * DSH rename or a patch release breaks silently — nothing fails at boot, the
 * plugin simply stops preloading or its peer stops matching:
 *
 * 1. every `dsh.client.inject` edge must name a package the installed core
 *    ships as a browser client module (`dsh.client.platform === 'web'`). A
 *    package renamed in the core (…-ui-slots -> …-ui-renderer in 0.2) leaves a
 *    dead edge behind; the browser module system skips unknown edges, so only
 *    a whole-client roster assembly notices.
 * 2. every `peerDependencies` range must be satisfied by a copy the plugin can
 *    actually resolve — its own `node_modules` first, then the core roots. A
 *    per-package core patch release (0.2.0-rc.2 -> 0.2.1-rc.2 for
 *    `dsh-api-session-controller`) silently invalidates an exact pin, and a
 *    stale local copy can satisfy a range the core no longer does.
 *
 * Discovery: the first of `DSH_CORE_MODULES`, `$DSH_HOME/profiles/node_modules`
 * and `~/.dsh/profiles/node_modules` that carries the core packages. Every test
 * is skipped when no core installation is present, so this file stays runnable
 * from a bare checkout.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The self-maintained plugins this guard covers, relative to the workspace root. */
const PLUGINS = [
  'dsh-cost-panel',
  'dsh-plugin-proxy',
  'dsh-service-watchdog',
  'dsh-session-id',
  'dsh-session-memo',
  'dsh-session-status',
]

const workspace = resolve(fileURLToPath(new URL('.', import.meta.url)), '../..')
const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')

/** Candidate module roots, most specific first. */
const roots = [
  process.env.DSH_CORE_MODULES,
  join(home, 'profiles', 'web', 'node_modules'),
  join(home, 'profiles', 'node_modules'),
].filter(candidate => typeof candidate === 'string' && candidate !== '')

const coreModules = roots.find(root => existsSync(join(root, '@deepseek-ai', 'dsh-settings', 'package.json')))
const skip = coreModules === undefined ? 'no installed DSH core found (set DSH_CORE_MODULES)' : false

/** Installed manifest of `name`, or undefined when the package is not installed. */
function copies(pluginDirectory, dependency) {
  const files = [
    join(workspace, pluginDirectory, 'node_modules', dependency, 'package.json'),
    ...roots.map(root => join(root, dependency, 'package.json')),
  ]
  return files
    .filter(file => existsSync(file))
    .map(file => ({ origin: file, manifest: JSON.parse(readFileSync(file, 'utf8')) }))
}

/** `semver` ships with the core install; the plugin packages do not depend on it. */
const semver = (() => {
  if (coreModules === undefined) return undefined
  try {
    return createRequire(join(coreModules, 'anchor.cjs'))('semver')
  } catch {
    return undefined
  }
})()

for (const directory of PLUGINS) {
  const manifest = JSON.parse(readFileSync(join(workspace, directory, 'package.json'), 'utf8'))

  test(`${manifest.name}: dsh.client.inject edges name installed browser client modules`, { skip }, () => {
    for (const dependency of manifest.dsh?.client?.inject ?? []) {
      const resolved = copies(directory, dependency)
      assert.ok(resolved.length > 0, `${manifest.name} injects ${dependency}, which is not installed anywhere it can resolve`)
      assert.ok(
        resolved.some(({ manifest: target }) => target.dsh?.client?.platform === 'web'),
        `${manifest.name} injects ${dependency}, which no installed copy ships as a browser client module`,
      )
    }
  })

  test(`${manifest.name}: peerDependencies are satisfied by a resolvable copy`, { skip }, () => {
    assert.ok(semver, `semver is not resolvable from ${coreModules}`)
    const optional = manifest.peerDependenciesMeta ?? {}
    for (const [dependency, range] of Object.entries(manifest.peerDependencies ?? {})) {
      const resolved = copies(directory, dependency)
      if (resolved.length === 0) {
        assert.ok(
          optional[dependency]?.optional === true,
          `${manifest.name} requires peer ${dependency}@${range}, which is not installed`,
        )
        continue
      }
      assert.ok(
        resolved.some(({ manifest: target }) => semver.satisfies(target.version, range, { includePrerelease: true })),
        `${manifest.name} requires peer ${dependency}@${range}; installed copies: ${
          resolved.map(({ origin, manifest: target }) => `${target.version} (${origin})`).join(', ')}`,
      )
    }
  })

  test(`${manifest.name}: every declared entry point exists`, { skip }, () => {
    for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
      if (subpath === './package.json' || !subpath.startsWith('.')) continue
      const file = typeof target === 'string' ? target : target?.default ?? Object.values(target ?? {})[0]
      assert.equal(typeof file, 'string', `${manifest.name} exports ${subpath} without a resolvable default`)
      assert.ok(existsSync(join(workspace, directory, file)), `${manifest.name} exports ${subpath} -> ${file}, which does not exist`)
    }
  })
}
