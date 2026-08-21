/**
 * Smoke test: the server plugin's export shape and Config schema against the
 * real @deepseek-ai packages (resolved through node_modules junctions).
 *
 * Run: `node test/plugin-shape.mjs`
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, apply, inject, name } from '../lib/index.js'

test('plugin export shape matches the Cordis loader contract', () => {
  assert.equal(name, 'proxy')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('tools'))
  assert.ok(inject.includes('systemPrompt'))
  assert.ok(inject.includes('settings'))
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function', 'schemastery schema is callable')
})

test('Config resolves composition defaults', () => {
  const config = Config({})
  assert.equal(config.enabled, false)
  assert.equal(config.mode, 'system')
  assert.equal(config.customUrl, 'http://127.0.0.1:7890')
  assert.equal(config.noProxy, 'localhost,127.0.0.1,::1')
})

test('Config accepts a full composition entry', () => {
  const config = Config({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:10809', noProxy: 'internal.local' })
  assert.equal(config.enabled, true)
  assert.equal(config.mode, 'custom')
  assert.equal(config.customUrl, 'http://127.0.0.1:10809')
  assert.equal(config.noProxy, 'internal.local')
})

test('Config rejects an unknown mode', () => {
  assert.throws(() => Config({ mode: 'banana' }))
})
