// 本地代理桥接:fingerprint-chromium 的 --proxy-server 不支持账号密码认证,
// 且部分内核对 SOCKS5 兼容不佳。这里用 proxy-chain 在 127.0.0.1 起一个匿名本地 HTTP 代理,
// 由它携带凭据转发到上游(HTTP / SOCKS5)。浏览器只连本地端口,凭据不外泄。
// profileId -> 本地代理 url(如 http://127.0.0.1:12345)
const bridges = new Map()
let proxyChainPromise

// 代理能力不是应用启动必需项。和 VS Code 延迟加载可选服务的思路一致，
// 首次真正使用认证代理时才解析 proxy-chain 及其依赖。
function loadProxyChain() {
  if (!proxyChainPromise) proxyChainPromise = import('proxy-chain')
  return proxyChainPromise
}

// 判断一个代理是否需要走本地桥接:带认证,或使用 SOCKS5
export function needsBridge(proxy) {
  if (!proxy || !proxy.enabled || !proxy.host || !proxy.port) return false
  return Boolean(proxy.username || proxy.password || proxy.type === 'socks5')
}

// 拼接上游代理 url(含凭据)
export function buildUpstreamUrl(proxy) {
  const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
  let auth = ''
  if (proxy.username || proxy.password) {
    auth = `${encodeURIComponent(proxy.username || '')}:${encodeURIComponent(proxy.password || '')}@`
  }
  return `${scheme}://${auth}${proxy.host}:${proxy.port}`
}

// 启动桥接,返回本地代理 url
export async function startBridge(key, proxy) {
  const { anonymizeProxy } = await loadProxyChain()
  const upstream = buildUpstreamUrl(proxy)
  const localUrl = await anonymizeProxy(upstream)
  bridges.set(key, localUrl)
  return localUrl
}

export async function stopBridge(key) {
  const localUrl = bridges.get(key)
  if (!localUrl) return
  bridges.delete(key)
  try {
    const { closeAnonymizedProxy } = await loadProxyChain()
    await closeAnonymizedProxy(localUrl, true)
  } catch {
    // ignore
  }
}

export async function stopAllBridges() {
  const keys = [...bridges.keys()]
  await Promise.all(keys.map((k) => stopBridge(k)))
}
