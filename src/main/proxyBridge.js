import https from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity } from 'node:tls'

// Chromium 只连接 127.0.0.1 上的匿名 HTTP 代理。桥接层负责代理认证、SOCKS5、
// HTTPS 上游证书策略，以及“系统代理 -> 指定出口代理”的串联。
const bridges = new Map()
let proxyChainPromise

function loadProxyChain() {
  if (!proxyChainPromise) proxyChainPromise = import('proxy-chain')
  return proxyChainPromise
}

function formatHost(host) {
  const value = String(host || '').trim()
  return value.includes(':') && !value.startsWith('[') ? `[${value}]` : value
}

function proxyScheme(type) {
  if (type === 'socks5') return 'socks5'
  if (type === 'https') return 'https'
  return 'http'
}

export function parseSystemProxyResult(value) {
  const entries = String(value || '')
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)

  for (const entry of entries) {
    const match = entry.match(/^(PROXY|HTTP|HTTPS|SOCKS|SOCKS4|SOCKS5)\s+(.+)$/i)
    if (!match) continue
    const [, kind, endpoint] = match
    const scheme = {
      PROXY: 'http',
      HTTP: 'http',
      HTTPS: 'https',
      SOCKS: 'socks5',
      SOCKS4: 'socks4',
      SOCKS5: 'socks5'
    }[kind.toUpperCase()]
    return `${scheme}://${endpoint}`
  }
  return ''
}

export function needsBridge(proxy) {
  if (!proxy?.enabled || !proxy.host || !proxy.port) return false
  return Boolean(
    proxy.useSystemProxy !== false ||
    proxy.username ||
    proxy.password ||
    proxy.type === 'socks5' ||
    proxy.type === 'https' ||
    proxy.ignoreTlsErrors
  )
}

export function buildUpstreamUrl(proxy, endpoint = {}) {
  const scheme = proxyScheme(proxy?.type)
  const host = formatHost(endpoint.host || proxy?.host)
  const port = String(endpoint.port || proxy?.port || '').trim()
  let auth = ''
  if (proxy?.username || proxy?.password) {
    auth = `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
  }
  return `${scheme}://${auth}${host}:${port}`
}

async function closeResource(resource) {
  if (!resource) return
  try {
    await resource.server?.close(true)
  } catch {
    // ignore
  }
  if (resource.tunnel) {
    try {
      const { closeTunnel } = await loadProxyChain()
      await closeTunnel(resource.tunnel, true)
    } catch {
      // ignore
    }
  }
  try {
    await resource.systemRelay?.close(true)
  } catch {
    // ignore
  }
  resource.httpsAgent?.destroy()
}

async function createSystemRelay(systemProxyUrl) {
  const { Server } = await loadProxyChain()
  const server = new Server({
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({
      requestAuthentication: false,
      upstreamProxyUrl: systemProxyUrl
    })
  })
  await server.listen()
  return server
}

function normalizeTlsHost(host) {
  const value = String(host || '').trim()
  return value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value
}

function createHttpsTunnelAgent(proxy) {
  const tlsHost = normalizeTlsHost(proxy?.host)
  return new https.Agent({
    keepAlive: true,
    // The URL points at the local TCP tunnel. Keep TLS identity bound to the real proxy.
    servername: isIP(tlsHost) ? '' : tlsHost,
    checkServerIdentity: (_hostname, certificate) => checkServerIdentity(tlsHost, certificate),
    rejectUnauthorized: !proxy?.ignoreTlsErrors
  })
}

export function createHttpsTunnelOptions(proxy, tunnelPort) {
  return {
    upstreamProxyUrl: buildUpstreamUrl(proxy, { host: '127.0.0.1', port: tunnelPort }),
    httpsAgent: createHttpsTunnelAgent(proxy)
  }
}

function summarizeFailure(stage, payload) {
  const response = payload?.response
  const error = payload?.error || (payload instanceof Error ? payload : null)
  const statusCode = Number(response?.statusCode)
  return {
    stage,
    ...(Number.isInteger(statusCode) ? { statusCode } : {}),
    ...(response?.statusMessage ? { statusMessage: response.statusMessage } : {}),
    ...(error?.code ? { code: error.code } : {}),
    ...(error?.message ? { message: error.message } : {})
  }
}

function observeServer(resource, server, stage) {
  server.on('tunnelConnectFailed', (payload) => {
    resource.failures.push(summarizeFailure(stage, payload))
    resource.failures = resource.failures.slice(-8)
  })
  server.on('requestFailed', (payload) => {
    resource.failures.push(summarizeFailure(stage, payload))
    resource.failures = resource.failures.slice(-8)
  })
  server.on('tlsError', (payload) => {
    resource.failures.push(summarizeFailure(stage, payload))
    resource.failures = resource.failures.slice(-8)
  })
}

export async function startBridge(key, proxy, options = {}) {
  await stopBridge(key)
  const { Server, createTunnel } = await loadProxyChain()
  const resource = { server: null, systemRelay: null, tunnel: '', httpsAgent: null, failures: [] }

  try {
    let upstreamProxyUrl = buildUpstreamUrl(proxy)
    const systemProxyUrl = proxy?.useSystemProxy !== false ? options.systemProxyUrl : ''

    if (systemProxyUrl) {
      resource.systemRelay = await createSystemRelay(systemProxyUrl)
      observeServer(resource, resource.systemRelay, 'system')
      const relayUrl = `http://127.0.0.1:${resource.systemRelay.port}`
      resource.tunnel = await createTunnel(relayUrl, `${formatHost(proxy.host)}:${proxy.port}`, {
        hostname: '127.0.0.1'
      })
      const tunnelPort = resource.tunnel.slice(resource.tunnel.lastIndexOf(':') + 1)

      if (proxy.type === 'https') {
        const tunnelOptions = createHttpsTunnelOptions(proxy, tunnelPort)
        upstreamProxyUrl = tunnelOptions.upstreamProxyUrl
        resource.httpsAgent = tunnelOptions.httpsAgent
      } else {
        upstreamProxyUrl = buildUpstreamUrl(proxy, { host: '127.0.0.1', port: tunnelPort })
      }
    }

    resource.server = new Server({
      host: '127.0.0.1',
      port: 0,
      prepareRequestFunction: () => ({
        requestAuthentication: false,
        upstreamProxyUrl,
        ignoreUpstreamProxyCertificate: Boolean(proxy.ignoreTlsErrors),
        ...(resource.httpsAgent ? { httpsAgent: resource.httpsAgent } : {})
      })
    })
    observeServer(resource, resource.server, 'configured')
    await resource.server.listen()
    resource.url = `http://127.0.0.1:${resource.server.port}`
    bridges.set(key, resource)
    return resource.url
  } catch (error) {
    await closeResource(resource)
    throw error
  }
}

export async function startSystemBridge(key, systemProxyUrl) {
  await stopBridge(key)
  if (!systemProxyUrl) return ''
  const server = await createSystemRelay(systemProxyUrl)
  const resource = { server, url: `http://127.0.0.1:${server.port}`, failures: [] }
  observeServer(resource, server, 'system')
  bridges.set(key, resource)
  return resource.url
}

export function getBridgeFailure(key) {
  const resource = bridges.get(key)
  if (!resource?.failures?.length) return null
  return resource.failures[resource.failures.length - 1]
}

export async function stopBridge(key) {
  const resource = bridges.get(key)
  if (!resource) return
  bridges.delete(key)
  await closeResource(resource)
}

export async function stopAllBridges() {
  const keys = [...bridges.keys()]
  await Promise.all(keys.map((key) => stopBridge(key)))
}
