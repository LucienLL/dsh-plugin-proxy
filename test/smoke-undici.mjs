/**
 * Smoke test: real undici routing through a local HTTP proxy.
 *
 * Proves the exact mechanism lib/index.js uses:
 * 1. `setGlobalDispatcher(new EnvHttpProxyAgent())` routes global `fetch()`
 *    through HTTP_PROXY/HTTPS_PROXY env.
 * 2. NO_PROXY entries bypass the proxy.
 * 3. Restoring the captured default dispatcher returns to direct routing.
 *
 * Run: `node test/smoke-undici.mjs` (needs `undici` resolvable from the
 * package — node_modules/undici).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import net from 'node:net'
import { setGlobalDispatcher, getGlobalDispatcher, EnvHttpProxyAgent } from 'undici'

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
 * A tiny HTTP proxy that handles CONNECT tunneling (undici ProxyAgent always
 * tunnels, even for http targets) and absolute-form http requests.
 */
function startProxy() {
  let hits = 0
  const server = http.createServer((req, res) => {
    // Absolute-form http request (used by plain http.request, not undici).
    hits += 1
    const target = new URL(req.url)
    const upstream = http.request(
      { hostname: target.hostname, port: target.port, path: target.pathname + target.search, method: req.method },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode, upstreamRes.headers)
        upstreamRes.pipe(res)
      })
    upstream.on('error', () => { res.writeHead(502); res.end() })
    req.pipe(upstream)
  })
  server.on('connect', (req, clientSocket, head) => {
    // CONNECT tunnel (undici's ProxyAgent path).
    hits += 1
    const [hostname, port] = req.url.split(':')
    const upstream = net.connect(Number(port), hostname, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length > 0) upstream.write(head)
      upstream.pipe(clientSocket)
      clientSocket.pipe(upstream)
    })
    upstream.on('error', () => clientSocket.destroy())
    clientSocket.on('error', () => upstream.destroy())
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port, hits: () => hits })
    })
  })
}

/** A tiny origin server. */
function startOrigin() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('origin-ok:' + req.url)
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, port: server.address().port })
    })
  })
}

/**
 * Close a server and force-drop its keep-alive sockets so the process can
 * exit even though undici pools keep connections open.
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections?.()
    setTimeout(resolve, 2000).unref?.()
  })
}

test('global fetch routes through EnvHttpProxyAgent and honors NO_PROXY', { timeout: 30000 }, async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const proxy = await startProxy()
  const origin = await startOrigin()
  let proxyAgent
  try {
    process.env.HTTP_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.HTTPS_PROXY = `http://127.0.0.1:${proxy.port}`
    process.env.ALL_PROXY = `http://127.0.0.1:${proxy.port}`
    delete process.env.NO_PROXY

    proxyAgent = new EnvHttpProxyAgent()
    setGlobalDispatcher(proxyAgent)

    // Proxied: the origin URL is NOT in NO_PROXY, so the request must travel
    // through the proxy server.
    const proxied = await fetch(`http://127.0.0.1:${origin.port}/via-proxy`)
    assert.equal(await proxied.text(), 'origin-ok:/via-proxy')
    assert.ok(proxy.hits() >= 1, 'expected the proxy to have been hit')

    // Bypassed: 127.0.0.1 in NO_PROXY → direct, proxy untouched.
    const before = proxy.hits()
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1'
    const direct = await fetch(`http://127.0.0.1:${origin.port}/direct`)
    assert.equal(await direct.text(), 'origin-ok:/direct')
    assert.equal(proxy.hits(), before, 'proxy must not be hit for a NO_PROXY host')
  } finally {
    setGlobalDispatcher(defaultDispatcher)
    restoreEnv(savedEnv)
    void proxyAgent?.close?.()
    await closeServer(proxy.server)
    await closeServer(origin.server)
  }
})

test('restoring the default dispatcher returns to direct routing', { timeout: 30000 }, async () => {
  const savedEnv = saveEnv()
  const defaultDispatcher = getGlobalDispatcher()
  const origin = await startOrigin()
  let proxyAgent
  try {
    process.env.HTTP_PROXY = 'http://127.0.0.1:9' // a dead proxy
    process.env.HTTPS_PROXY = 'http://127.0.0.1:9'
    proxyAgent = new EnvHttpProxyAgent()
    setGlobalDispatcher(proxyAgent)
    await assert.rejects(fetch(`http://127.0.0.1:${origin.port}/`))

    setGlobalDispatcher(defaultDispatcher)
    delete process.env.HTTP_PROXY
    delete process.env.HTTPS_PROXY
    const ok = await fetch(`http://127.0.0.1:${origin.port}/direct-again`)
    assert.equal(await ok.text(), 'origin-ok:/direct-again')
  } finally {
    setGlobalDispatcher(defaultDispatcher)
    restoreEnv(savedEnv)
    void proxyAgent?.close?.()
    await closeServer(origin.server)
  }
})
