import { randomUUID } from 'node:crypto'
import { request, ProxyAgent } from 'undici'
import { getBridgeFailure, startBridge, startSystemBridge, stopBridge } from './proxyBridge.js'
import { localeForCountry } from './locale.js'
import { proxyIdentity } from './profileManifest.js'

const REQUEST_TIMEOUT_MS = 8000

export const GEO_PROVIDERS = [
  { id: 'ipinfo', label: 'IPinfo', url: 'https://ipinfo.io/json' },
  { id: 'ip123', label: 'IP123.in / IP234.in', url: 'http://ip234.in/ip.json' },
  { id: 'iprust', label: 'IPRust', url: 'http://iprust.io/ip.json' },
  {
    id: 'ip-api',
    label: 'IP-API',
    url: 'http://ip-api.com/json/?fields=status,message,countryCode,country,timezone,lat,lon,query'
  },
  { id: 'ip2location', label: 'IP2Location', url: 'https://api.ip2location.io/?format=json' }
]

function coordinates(value) {
  if (Array.isArray(value)) return value.map(Number)
  return String(value || '').split(',').map(Number)
}

export function parseProviderData(providerId, data) {
  if (!data || typeof data !== 'object') throw new Error('响应不是 JSON 对象')
  if (providerId === 'ip-api') {
    if (data.status !== 'success') throw new Error(data.message || '服务返回失败')
    return {
      ip: data.query,
      country: data.country,
      countryCode: data.countryCode,
      timezone: data.timezone,
      latitude: data.lat,
      longitude: data.lon
    }
  }
  if (providerId === 'ipinfo') {
    const [latitude, longitude] = coordinates(data.loc)
    return {
      ip: data.ip,
      country: data.country_name || data.country,
      countryCode: data.country_code || data.country,
      timezone: data.timezone || data.geo?.timezone,
      latitude: data.latitude ?? data.geo?.latitude ?? latitude,
      longitude: data.longitude ?? data.geo?.longitude ?? longitude
    }
  }
  if (providerId === 'ip123') {
    return {
      ip: data.ip,
      country: data.country,
      countryCode: data.country_code,
      timezone: data.timezone,
      latitude: data.latitude,
      longitude: data.longitude
    }
  }
  if (providerId === 'iprust') {
    return {
      ip: data.ip,
      country: data.country_long,
      countryCode: data.country_short,
      timezone: data.timezone,
      latitude: data.latitude,
      longitude: data.longitude
    }
  }
  if (providerId === 'ip2location') {
    return {
      ip: data.ip,
      country: data.country_name,
      countryCode: data.country_code,
      timezone: data.time_zone,
      latitude: data.latitude,
      longitude: data.longitude
    }
  }
  throw new Error('不支持的 GeoIP 服务')
}

function normalizeResult(provider, data, proxy, systemProxyUrl) {
  const parsed = parseProviderData(provider.id, data)
  const timezone = String(parsed.timezone || '').trim()
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format()
  } catch {
    throw new Error('未返回有效的 IANA 时区')
  }
  if (!parsed.ip || !parsed.countryCode) throw new Error('响应缺少 IP 或国家代码')

  const countryCode = String(parsed.countryCode).toUpperCase()
  const locale = localeForCountry(countryCode)
  return {
    ip: String(parsed.ip),
    country: String(parsed.country || countryCode),
    countryCode,
    timezone,
    latitude: Number.isFinite(Number(parsed.latitude)) ? Number(parsed.latitude) : null,
    longitude: Number.isFinite(Number(parsed.longitude)) ? Number(parsed.longitude) : null,
    language: locale.language,
    acceptLanguages: locale.acceptLanguages,
    source: provider.label,
    proxyIdentity: proxyIdentity(proxy),
    systemProxy: Boolean(systemProxyUrl && proxy?.useSystemProxy !== false),
    checkedAt: new Date().toISOString()
  }
}

function conciseError(error) {
  const code = error?.cause?.code || error?.code
  const message = error?.message || String(error)
  return code && !message.includes(code) ? `${code} ${message}` : message
}

export function describeBridgeFailure(proxy, failure) {
  if (!failure) return ''
  const statusCode = Number(failure.statusCode)
  const protocol = String(proxy?.type || 'http').toUpperCase()
  if (statusCode === 401 || statusCode === 407) {
    return `指定 ${protocol} 代理要求认证（HTTP ${statusCode}），请填写代理用户名和密码`
  }
  if (statusCode >= 400 && statusCode < 500) {
    if (protocol === 'HTTPS') {
      return `指定 HTTPS 代理在 TLS 隧道中返回 HTTP ${statusCode}，它可能是普通 HTTP 代理、网页入口、协议/端口不匹配，或要求其他认证方式；端口 443 本身不代表必须选择 HTTPS`
    }
    return `指定 ${protocol} 代理拒绝 CONNECT（HTTP ${statusCode}），请核对代理协议、端口和账号密码`
  }
  if (statusCode >= 500) {
    return `代理链路返回 HTTP ${statusCode}，请核对指定代理是否在线以及系统代理/V2Ray 是否允许连接该地址`
  }
  if (failure.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || failure.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
    return '指定代理的 TLS 证书无法通过校验；仅在确认代理可信时开启“跳过代理证书认证”'
  }
  if (failure.code) return `代理 ${failure.stage === 'system' ? '系统/V2Ray' : '指定出口'} 阶段失败（${failure.code}）`
  if (failure.message) return `代理 ${failure.stage === 'system' ? '系统/V2Ray' : '指定出口'} 阶段失败：${failure.message}`
  return ''
}

async function queryProvider(provider, dispatcher, proxy, systemProxyUrl, controller) {
  try {
    const { statusCode, body } = await request(provider.url, {
      dispatcher,
      signal: controller.signal,
      headers: { accept: 'application/json', 'user-agent': 'FingerBrowser/0.2' },
      headersTimeout: REQUEST_TIMEOUT_MS,
      bodyTimeout: REQUEST_TIMEOUT_MS
    })
    if (statusCode !== 200) {
      await body.dump()
      throw new Error(`HTTP ${statusCode}`)
    }
    return normalizeResult(provider, await body.json(), proxy, systemProxyUrl)
  } catch (error) {
    throw new Error(`${provider.label}: ${conciseError(error)}`)
  }
}

export async function detectGeo(proxy, options = {}) {
  const key = `geo:${randomUUID()}`
  const systemProxyUrl = proxy?.useSystemProxy !== false ? options.systemProxyUrl || '' : ''
  let localUrl = ''
  let dispatcher
  const controllers = GEO_PROVIDERS.map(() => new AbortController())

  try {
    if (proxy?.enabled && proxy.host && proxy.port) {
      localUrl = await startBridge(key, proxy, { systemProxyUrl })
    } else if (systemProxyUrl) {
      localUrl = await startSystemBridge(key, systemProxyUrl)
    }
    if (localUrl) {
      dispatcher = new ProxyAgent(localUrl)
    }

    const attempts = GEO_PROVIDERS.map((provider, index) =>
      queryProvider(provider, dispatcher, proxy, systemProxyUrl, controllers[index])
    )
    try {
      return await Promise.any(attempts)
    } catch (aggregate) {
      const details = (aggregate.errors || []).map(conciseError).join('；')
      const bridgeHint = describeBridgeFailure(proxy, getBridgeFailure(key))
      const diagnosis = bridgeHint ? `链路诊断：${bridgeHint}。` : ''
      throw new Error(`出口 IP 检测失败。${diagnosis}已尝试 ${GEO_PROVIDERS.map((item) => item.label).join('、')}。技术详情：${details}`)
    } finally {
      controllers.forEach((controller) => controller.abort())
      await Promise.allSettled(attempts)
    }
  } finally {
    if (dispatcher) {
      try {
        await dispatcher.close()
      } catch {
        // ignore
      }
    }
    await stopBridge(key)
  }
}
