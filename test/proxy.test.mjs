/**
 * Unit tests for the pure proxy-resolution logic (lib/proxy.js).
 * Run as a main module: `node test/proxy.test.mjs` (the sandbox blocks the
 * `node --test` runner's child processes).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  composeNoProxy,
  makeWindowsSystemProxyReader,
  normalizeProxyUrl,
  parseOverrideEntries,
  parseProxyServer,
  parseRegDword,
  parseRegString,
  queryRegValue,
  resolveProxyState,
  systemFactsEqual,
} from '../lib/proxy.js'

test('normalizeProxyUrl accepts bare host:port', () => {
  assert.equal(normalizeProxyUrl('127.0.0.1:7890'), 'http://127.0.0.1:7890')
  assert.equal(normalizeProxyUrl('  proxy.local:8080 '), 'http://proxy.local:8080')
})

test('normalizeProxyUrl keeps an existing scheme and rejects garbage', () => {
  assert.equal(normalizeProxyUrl('https://proxy.example.com:8443/'), 'https://proxy.example.com:8443')
  assert.equal(normalizeProxyUrl('socks5://127.0.0.1:1080'), null)
  assert.equal(normalizeProxyUrl(''), null)
  assert.equal(normalizeProxyUrl(undefined), null)
  assert.equal(normalizeProxyUrl('http://'), null)
  assert.equal(normalizeProxyUrl('://nohost'), null)
})

test('parseProxyServer handles the bare host:port form', () => {
  const out = parseProxyServer('127.0.0.1:10808')
  assert.deepEqual(out, { http: 'http://127.0.0.1:10808', https: 'http://127.0.0.1:10808' })
})

test('parseProxyServer handles the per-protocol form and ignores socks', () => {
  const out = parseProxyServer('http=10.0.0.1:8080;https=10.0.0.2:8443;socks=10.0.0.3:1080')
  assert.deepEqual(out, { http: 'http://10.0.0.1:8080', https: 'http://10.0.0.2:8443' })
})

test('parseProxyServer rejects empty or garbage input', () => {
  assert.equal(parseProxyServer(''), null)
  assert.equal(parseProxyServer(undefined), null)
  assert.equal(parseProxyServer('   '), null)
  assert.equal(parseProxyServer('http=not a url'), null)
})

test('parseRegDword and parseRegString decode reg query lines', () => {
  assert.equal(parseRegDword('    ProxyEnable    REG_DWORD    0x1'), 1)
  assert.equal(parseRegDword('    ProxyEnable    REG_DWORD    0x0'), 0)
  assert.equal(parseRegDword('no match'), undefined)
  assert.equal(parseRegString('    ProxyServer    REG_SZ    127.0.0.1:10808'), '127.0.0.1:10808')
  assert.equal(parseRegString('no match'), undefined)
})

test('queryRegValue extracts the raw value token', () => {
  assert.equal(queryRegValue('    ProxyServer    REG_SZ    127.0.0.1:10808\n'), '127.0.0.1:10808')
  assert.equal(queryRegValue('    ProxyEnable    REG_DWORD    0x1\n'), '0x1')
  assert.equal(queryRegValue(null), null)
})

test('composeNoProxy always includes the loopbacks and maps <local>', () => {
  assert.equal(composeNoProxy(undefined), 'localhost,127.0.0.1,::1')
  assert.equal(composeNoProxy(''), 'localhost,127.0.0.1,::1')
  assert.equal(composeNoProxy('10.0.0.0/8, api.internal, <local>, 127.0.0.1'),
    'localhost,127.0.0.1,::1,10.0.0.0/8,api.internal')
})

test('resolveProxyState: master switch off always wins', () => {
  const state = resolveProxyState({ enabled: false, mode: 'system', customUrl: 'http://x:1', noProxy: '' }, { enabled: true, url: 'http://sys:1' })
  assert.equal(state.active, false)
  assert.equal(state.reason, 'disabled')
})

test('resolveProxyState: mode none means direct even when enabled', () => {
  const state = resolveProxyState({ enabled: true, mode: 'none', customUrl: 'http://x:1', noProxy: '' }, { enabled: true, url: 'http://sys:1' })
  assert.equal(state.active, false)
  assert.equal(state.reason, 'mode-none')
})

test('resolveProxyState: custom mode uses the custom URL', () => {
  const state = resolveProxyState({ enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890', noProxy: '' }, null)
  assert.equal(state.active, true)
  assert.equal(state.url, 'http://127.0.0.1:7890')
  assert.equal(state.reason, 'custom')
})

test('resolveProxyState: custom mode with an invalid URL falls back to direct', () => {
  const state = resolveProxyState({ enabled: true, mode: 'custom', customUrl: 'http://', noProxy: '' }, null)
  assert.equal(state.active, false)
  assert.equal(state.reason, 'invalid-custom-url')
})

test('resolveProxyState: system mode follows the system proxy facts', () => {
  const on = resolveProxyState(
    { enabled: true, mode: 'system', customUrl: '', noProxy: '' },
    { enabled: true, url: 'http://127.0.0.1:10808', http: 'http://127.0.0.1:10808', https: 'http://127.0.0.1:10808' })
  assert.equal(on.active, true)
  assert.equal(on.url, 'http://127.0.0.1:10808')
  assert.equal(on.reason, 'system')
  const off = resolveProxyState(
    { enabled: true, mode: 'system', customUrl: '', noProxy: '' },
    { enabled: false, url: null })
  assert.equal(off.active, false)
  assert.equal(off.reason, 'system-proxy-off')
})

test('system proxy reader queries reg.exe and decodes the facts', async () => {
  const calls = []
  const execFile = async (file, args) => {
    calls.push([file, args])
    const value = args[args.length - 1]
    if (value === 'ProxyEnable') return { stdout: '    ProxyEnable    REG_DWORD    0x1\n' }
    if (value === 'ProxyServer') return { stdout: '    ProxyServer    REG_SZ    127.0.0.1:10808\n' }
    return { stdout: '    ProxyOverride    REG_SZ    <local>;localhost;10.*\n' }
  }
  const reader = makeWindowsSystemProxyReader(execFile)
  const facts = await reader()
  assert.equal(calls.length, 3)
  assert.ok(calls.every(([file]) => file === 'reg'))
  assert.equal(facts.enabled, true)
  assert.equal(facts.url, 'http://127.0.0.1:10808')
  assert.equal(facts.override, '<local>;localhost;10.*')
})

test('system proxy reader tolerates a failed query', async () => {
  const execFile = async () => { throw new Error('reg not found') }
  const reader = makeWindowsSystemProxyReader(execFile)
  const facts = await reader()
  assert.equal(facts.enabled, false)
  assert.equal(facts.url, null)
})

test('parseOverrideEntries maps <local> and keeps usable entries only', () => {
  const entries = parseOverrideEntries('<local>;localhost;*.corp.example;.intra;10.*;127.*;192.168.*;proxy.local:8080')
  assert.deepEqual(entries, ['localhost', '127.0.0.1', '::1', '*.corp.example', '.intra', 'proxy.local:8080'])
  assert.deepEqual(parseOverrideEntries(''), [])
  assert.deepEqual(parseOverrideEntries(undefined), [])
  assert.deepEqual(parseOverrideEntries('10.*;*'), [])
})

test('composeNoProxy merges the Windows override into the bypass list', () => {
  assert.equal(composeNoProxy('localhost,127.0.0.1,::1', '<local>;api.internal;10.*'),
    'localhost,127.0.0.1,::1,api.internal')
  assert.equal(composeNoProxy(undefined, undefined), 'localhost,127.0.0.1,::1')
})

test('resolveProxyState merges the system override in system mode', () => {
  const on = resolveProxyState(
    { enabled: true, mode: 'system', customUrl: '', noProxy: '' },
    { enabled: true, url: 'http://127.0.0.1:10808', http: 'http://127.0.0.1:10808', https: 'http://127.0.0.1:10808', override: '<local>;api.internal;10.*' })
  assert.equal(on.active, true)
  assert.equal(on.noProxy, 'localhost,127.0.0.1,::1,api.internal')
  // Custom mode must NOT pick up the system override.
  const custom = resolveProxyState(
    { enabled: true, mode: 'custom', customUrl: 'http://127.0.0.1:7890', noProxy: 'x.internal' },
    { enabled: true, url: 'http://127.0.0.1:10808', override: 'api.internal' })
  assert.equal(custom.noProxy, 'localhost,127.0.0.1,::1,x.internal')
})

test('systemFactsEqual detects real changes only', () => {
  const a = { enabled: true, url: 'http://127.0.0.1:10808', override: '<local>' }
  assert.equal(systemFactsEqual(a, { ...a }), true)
  assert.equal(systemFactsEqual(a, { ...a, override: '<local>;10.*' }), false)
  assert.equal(systemFactsEqual(a, { ...a, url: 'http://127.0.0.1:10809' }), false)
  assert.equal(systemFactsEqual(a, { ...a, enabled: false }), false)
  assert.equal(systemFactsEqual(null, null), true)
  assert.equal(systemFactsEqual(a, null), false)
})
