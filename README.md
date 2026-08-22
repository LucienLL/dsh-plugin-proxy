# dsh-plugin-proxy

Global proxy for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): route **agent tools, model requests and web fetches** through the Windows system proxy or a custom proxy — with one persistent switch in the main UI, an editable settings card, and **agent-visible proxy status** so the model always knows whether traffic is proxied.

## Why

Without a proxy, outbound network operations fail and the agent burns tokens retrying. With this plugin, the whole runtime goes through the proxy the moment you flip one switch — and because the agent is *told* the proxy state in its system prompt (and can query/toggle it with tools), it never silently routes an operation that must go direct through the proxy.

## What it does

| Concern | Mechanism |
| --- | --- |
| **Model requests** (chat completions, SSE streaming, web search/fetch providers) | Swaps the undici **global dispatcher** to `EnvHttpProxyAgent` — every in-process `fetch()` (all LLM adapters use global fetch) is routed through the proxy. |
| **Agent subprocesses** (`curl`, `git`, `npm`, `pwsh`-spawned tools) | Writes `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY` into `process.env`, which the harness's child env inherits. |
| **Agent awareness** | A dynamic system-prompt section (`Proxy status: ON/OFF`) is re-rendered on every request; plus two model tools — `proxy_status` (read) and `proxy_set` (toggle). |
| **Persistence** | Settings live in the `proxy` settings namespace (Settings → Plugins → Proxy in the web UI), layered over the composition entry, applied live (`applies: live`) — no restart to change values. |

## UI

- **Persistent switch** at the sidebar foot (always visible): one click toggles the proxy on/off. Collapsed rail keeps a compact switch.
- **Settings card** under *Settings → Plugins → Proxy*:
  - **代理地址来源 (address source)**: `系统代理` (Windows Internet Settings) / `自定义地址` (custom URL) / `不使用代理` (none).
  - **自定义代理地址 (custom URL)**: e.g. `http://127.0.0.1:7890`.
  - **直连名单 (NO_PROXY)**: comma-separated bypass hosts. `localhost` / `127.0.0.1` / `::1` are always direct.

## Agent-facing behavior

The model's system prompt always states the current proxy state, the effective address, and the NO_PROXY bypass list, and instructs the agent to:

- treat every outbound request as proxied unless the host is on the bypass list;
- go direct for localhost / internal targets (bypass list);
- use `proxy_set` with `enabled=false` for operations that must NOT use the proxy, then re-enable afterwards;
- check `proxy_status` before retrying failed network operations instead of blindly retrying.

`proxy_set` persists the change — the switch in the UI follows it.

## Install

```sh
# in the DSH profile directory (or anywhere, then restart DSH)
dsh plugin --profile web add dsh-plugin-proxy
```

or add the package to your profile `package.json` dependencies and `dsh.profile.bundles`, then restart DSH. The first install requires a DSH restart; after that all configuration is live.

## Configuration

All fields are editable in the settings UI; the same schema accepts composition defaults:

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | Master switch (also toggled from the sidebar / `proxy_set`). |
| `mode` | `system` \| `custom` \| `none` | `system` | Proxy address source. |
| `customUrl` | string | `http://127.0.0.1:7890` | Used when `mode: custom`. |
| `noProxy` | string | `localhost,127.0.0.1,::1` | NO_PROXY bypass list (`<local>` maps to the loopbacks). |
| `systemPollMs` | number | `30000` | Poll interval (ms) for the Windows system proxy while `mode: system` + enabled, so the runtime follows the system proxy being toggled on/off; `0` disables polling. |

In `mode: system` the Windows `ProxyOverride` bypass list is merged into
NO_PROXY (`<local>` and `*.domain` entries honored; IP-prefix wildcards like
`127.*` are dropped because undici cannot express them).

## Development

```sh
node --check lib/index.js && node --check lib/proxy.js && node --check lib/client.js
node test/proxy.test.mjs      # pure logic
node test/plugin-shape.mjs    # export shape against real @deepseek-ai packages
node test/apply.mjs           # end-to-end: mount the plugin, toggle the proxy live
node test/client-shape.mjs    # browser inject contract (service names only)
node test/smoke-undici.mjs    # real undici routing through a local proxy
```

The `@deepseek-ai/*` peer dependencies and `undici` must resolve for the tests
(junction them to the DSH checkout / profile `node_modules`, or `pnpm install`).

> Maintainer note: the browser bundle's `exports.inject` must list Cordis
> **service names** (`slots`, `settingsScope`), never package names — a
> package-name list there keeps the plugin permanently pending and blocks web
> boot. See [`docs/LESSONS.md`](docs/LESSONS.md) and the `client-shape` test.

## Notes & limitations

- The dispatcher swap covers in-process `fetch()`; it does not configure the WebView/Chromium used by the DSH desktop shell (browser traffic already follows the OS system proxy).
- `mode: system` reads the Windows *user* proxy (HKCU Internet Settings) via `reg.exe`; SOCKS-only proxies are not usable by undici's HTTP CONNECT agents — use a mixed/HTTP proxy address.
- The plugin ships a hand-written browser client (`lib/client.js`, no build step), the same loader format as dsh-plugin-focus.
