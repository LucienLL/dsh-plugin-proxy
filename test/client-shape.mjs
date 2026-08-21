import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const clientSource = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')

test('browser face injects Cordis service names rather than package names', () => {
  let registration
  const context = vm.createContext({
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
    },
  })

  vm.runInContext(clientSource, context)
  assert.equal(registration?.id, 'dsh-plugin-proxy/client')

  const client = registration.factory((specifier) => {
    if (specifier === 'react') {
      return {
        useSyncExternalStore: () => undefined,
        createElement: () => undefined,
      }
    }
    throw new Error(`unexpected client external: ${specifier}`)
  })

  assert.deepEqual(Array.from(client.inject), ['slots', 'settingsScope'])
})
