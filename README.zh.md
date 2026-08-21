# dsh-plugin-proxy

DeepSeek Harness (DSH) 全局代理插件：通过**系统代理**或**自定义地址**，让 **Agent 工具、模型请求、网页抓取**统一走代理 —— 主界面常驻一个开关，设置界面可配置地址来源，并且**模型在对话中始终明确感知当前代理状态**，避免必须直连的操作被误走代理。

## 解决的问题

不走代理时，外网操作频繁失败，Agent 会反复重试而白白消耗 token。本插件让整个运行时代理开关一开即全局生效；同时系统提示中实时标注代理状态，并提供了 `proxy_status`（查询）与 `proxy_set`（切换）两个工具，模型不会在不知情的情况下被迫走代理。

## 工作原理

| 对象 | 机制 |
| --- | --- |
| **模型请求**（对话补全、SSE 流式、web_search/web_fetch 提供商） | 替换 undici **全局调度器**为 `EnvHttpProxyAgent` —— 进程内所有 `fetch()`（所有 LLM 适配器都用全局 fetch）都走代理。 |
| **Agent 子进程**（`curl`/`git`/`npm`/pwsh 等工具） | 向 `process.env` 写入 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY`/`NO_PROXY`，DSH 的子进程环境会继承。 |
| **Agent 感知** | 每次请求时动态重渲染系统提示段落（`Proxy status: ON/OFF`）；另有 `proxy_status`（读）与 `proxy_set`（写）两个模型工具。 |
| **持久化** | 配置存放在 `proxy` 设置命名空间（设置 → 插件 → 代理），叠加在组合配置之上，**实时生效**（`applies: live`），改配置无需重启。 |

## 界面

- **主界面常驻开关**：位于侧边栏底部，始终可见，一键切换代理开关；侧边栏收起为窄栏时保留紧凑开关。
- **设置卡片**（设置 → 插件 → 代理）：
  - **代理地址来源**：`系统代理`（Windows Internet 设置）/ `自定义地址` / `不使用代理`。
  - **自定义代理地址**：如 `http://127.0.0.1:7890`。
  - **直连名单（NO_PROXY）**：逗号分隔；`localhost` / `127.0.0.1` / `::1` 始终直连。

## Agent 侧行为

系统提示中始终标注：当前代理状态、生效地址、直连名单，并指示 Agent：

- 除非目标在直连名单内，否则默认所有外发请求都走代理；
- 本机 / 内网目标直接访问（在直连名单内）；
- 必须直连的操作先调用 `proxy_set`（enabled=false），完成后恢复（enabled=true）；
- 网络操作失败时先查 `proxy_status` 再决定是否重试，不要盲目反复重试。

`proxy_set` 的改动会被持久化，界面开关随之同步。

## 安装

```sh
# 在 DSH 的 profile 目录（或任意位置），随后重启 DSH
dsh plugin --profile web add dsh-plugin-proxy
```

或手动把包加入 profile 的 `package.json` 依赖与 `dsh.profile.bundles`，然后重启 DSH。首次安装需要重启 DSH；之后所有配置均实时生效。

## 配置项

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `enabled` | boolean | `false` | 总开关（侧边栏开关 / `proxy_set` 也改这里）。 |
| `mode` | `system` \| `custom` \| `none` | `system` | 代理地址来源。 |
| `customUrl` | string | `http://127.0.0.1:7890` | `mode: custom` 时使用。 |
| `noProxy` | string | `localhost,127.0.0.1,::1` | 直连名单（`<local>` 映射为本机回环地址）。 |

## 开发与测试

```sh
node --check lib/index.js && node --check lib/proxy.js && node --check lib/client.js
node test/proxy.test.mjs      # 纯逻辑单测
node test/plugin-shape.mjs    # 导出形状（对真实 @deepseek-ai 包）
node test/apply.mjs           # 端到端：挂载插件、实时切换代理
node test/client-shape.mjs    # 浏览器端 inject 契约（只能写服务名）
node test/smoke-undici.mjs    # 真实 undici 经本地代理路由
```

测试需要能解析 `@deepseek-ai/*` peer 依赖与 `undici`（可 junction 到 DSH 安装 / profile 的 `node_modules`，或 `pnpm install`）。

> 维护者注意：浏览器端 `exports.inject` 必须写 Cordis **服务名**（`slots`、`settingsScope`），绝不能写包名——写包名会让插件永久 pending 并卡死 web boot。详见 [`docs/LESSONS.md`](docs/LESSONS.md) 与 `client-shape` 回归测试。

## 已知限制

- 调度器替换覆盖进程内 `fetch()`，不配置桌面端 WebView/Chromium（浏览器流量本就跟随系统代理）。
- `mode: system` 读取 Windows **用户**代理（HKCU Internet 设置，通过 `reg.exe`）；纯 SOCKS 代理无法被 undici 的 HTTP CONNECT 使用 —— 请使用 HTTP 混合代理地址。
- 浏览器端客户端为手写模块（`lib/client.js`，无需构建），与 dsh-plugin-focus 相同的加载器格式。
