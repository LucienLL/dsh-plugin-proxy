# Lessons Learned

Durable lessons from shipping this plugin — read before touching the client bundle.

## 1. `exports.inject` (browser bundle) takes Cordis **service names**, not package names

**Incident (2026-08-21):** the first install of this plugin prevented DSH from
booting: `web boot: 1 entry did not activate dsh-plugin-proxy` — the plugin sat
permanently `pending` because its browser half declared

```js
exports.inject = ["@deepseek-ai/dsh-client-runtime", ...] // WRONG — package names
```

The browser-side Cordis loader waits for **services** by name, so those
packages could never resolve as services and the fiber never activated.

**The two injects are different things:**

| Location | Meaning | Values |
| --- | --- | --- |
| `package.json` → `dsh.client.inject` | module-graph edges (which bundles to load) | **package names** (`@deepseek-ai/dsh-client-*`) |
| `lib/client.js` → `exports.inject` | Cordis service dependencies (which fibers to wait for) | **service names** (`slots`, `settingsScope`, `locale`, `connection`, `remote`) |

The correct value here is what `apply()` actually uses:

```js
exports.inject = ["slots", "settingsScope"];
```

(`settingsScope` is provided by `@deepseek-ai/dsh-client-ui-settings`.)

**Regression guard:** `test/client-shape.mjs` executes `lib/client.js` in a
`vm` and asserts `exports.inject` equals exactly `["slots", "settingsScope"]`.
Keep that test; extend it if the client starts using another service.

**Reference trap:** the original `dsh-plugin-focus` client bundle also wrote
package names into `exports.inject`. Do not copy that line from it.

## 2. Node 24 test runner: use `node --test test/*.mjs`

`node --test test/` fails on Node 24 (a directory is not a module). The
package script is `node --test test/*.mjs`. Run individual files directly too
when debugging.

## 3. `dsh plugin add` + `--dump-config` is not a boot acceptance test

It verifies the composition tree only. Client-fiber activation (and every
`exports.inject` mistake) only shows up on a real service restart — restart
DSH and check the page for `did not activate` / `pending` before declaring a
client-bearing plugin done.

## Related environment landmine

A profile-level drift of `@deepseek-ai/dsh-tools` (a nested old copy pulled in
by another plugin) crashed DSH with `Cannot read properties of undefined
(reading 'prepare')`. The fix on this machine is the profile
`pnpm-workspace.yaml` override pinning `@deepseek-ai/dsh-tools` to the harness
core link. When adding dependencies, re-check nested `node_modules` for stale
`@deepseek-ai/*` copies.
