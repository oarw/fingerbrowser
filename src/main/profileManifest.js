import { normalizeStartupPolicy } from './launchPolicy.js'

export const PROFILE_MANIFEST_VERSION = 2

function clean(value) {
  return typeof value === 'string' ? value.trim() : ''
}

function primaryLanguage(value) {
  return clean(value).split(',')[0].split(';')[0].trim().toLowerCase()
}

function isValidTimezone(value) {
  if (!clean(value)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}

export function proxyIdentity(proxy) {
  if (!proxy?.enabled) return 'direct'
  const type = ['http', 'https', 'socks5'].includes(proxy.type) ? proxy.type : 'http'
  const host = clean(proxy.host).toLowerCase()
  const port = clean(String(proxy.port ?? ''))
  return `${type}://${host}:${port}`
}

function normalizeGeo(geo) {
  if (!geo || typeof geo !== 'object') return null
  return {
    ip: clean(geo.ip),
    country: clean(geo.country),
    countryCode: clean(geo.countryCode).toUpperCase(),
    timezone: clean(geo.timezone),
    latitude: Number.isFinite(Number(geo.latitude ?? geo.lat)) ? Number(geo.latitude ?? geo.lat) : null,
    longitude: Number.isFinite(Number(geo.longitude ?? geo.lon)) ? Number(geo.longitude ?? geo.lon) : null,
    language: clean(geo.language),
    acceptLanguages: clean(geo.acceptLanguages),
    source: clean(geo.source) || 'unknown',
    proxyIdentity: clean(geo.proxyIdentity),
    systemProxy: Boolean(geo.systemProxy),
    checkedAt: clean(geo.checkedAt) || new Date().toISOString()
  }
}

function normalizeProxyHealth(health, geo, currentProxyIdentity) {
  const inferredStatus = geo ? 'available' : 'unknown'
  const status = ['unknown', 'available', 'unavailable'].includes(health?.status)
    ? health.status
    : inferredStatus
  return {
    status,
    checkedAt: clean(health?.checkedAt),
    error: status === 'unavailable' ? clean(health?.error) : '',
    proxyIdentity: status === 'unknown' ? '' : clean(health?.proxyIdentity) || currentProxyIdentity
  }
}

function normalizeProfile(profile) {
  const fingerprint = profile?.fingerprint || {}
  const proxy = profile?.proxy || {}
  const language = clean(fingerprint.language)
  const seed = Number(fingerprint.seed)
  return {
    ...profile,
    fingerprint: {
      ...fingerprint,
      seed: Number.isInteger(seed) && seed >= 0 && seed <= 0xffffffff ? seed : fingerprint.seed,
      platform: clean(fingerprint.platform) || 'windows',
      brand: clean(fingerprint.brand) || 'Chrome',
      hardwareConcurrency: Number(fingerprint.hardwareConcurrency) || 8,
      language,
      acceptLanguages: clean(fingerprint.acceptLanguages) || (language ? `${language},${language.split('-')[0]}` : ''),
      timezone: clean(fingerprint.timezone),
      webrtcMode: clean(fingerprint.webrtcMode) || 'disable_non_proxied_udp'
    },
    proxy: {
      enabled: Boolean(proxy.enabled),
      type: ['http', 'https', 'socks5'].includes(proxy.type) ? proxy.type : 'http',
      host: clean(proxy.host),
      port: clean(String(proxy.port ?? '')),
      username: clean(proxy.username),
      password: typeof proxy.password === 'string' ? proxy.password : '',
      useSystemProxy: proxy.useSystemProxy !== false,
      ignoreTlsErrors: Boolean(proxy.ignoreTlsErrors)
    },
    startupPolicy: normalizeStartupPolicy(profile?.startupPolicy)
  }
}

export function validateProfileConsistency(profile, geoOverride) {
  const normalized = normalizeProfile(profile)
  const fingerprint = normalized.fingerprint
  const proxy = normalized.proxy
  const geo = normalizeGeo(geoOverride ?? profile?.manifest?.geo)
  const issues = []
  const add = (code, severity, field, message) => issues.push({ code, severity, field, message })

  const seed = Number(fingerprint.seed)
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) {
    add('FINGERPRINT_SEED_INVALID', 'error', 'fingerprint.seed', '指纹种子必须是 0 到 4294967295 的整数')
  }
  if (!fingerprint.timezone) {
    add('TIMEZONE_REQUIRED', 'error', 'fingerprint.timezone', '需要设置 IANA 时区')
  } else if (!isValidTimezone(fingerprint.timezone)) {
    add('TIMEZONE_INVALID', 'error', 'fingerprint.timezone', `时区 ${fingerprint.timezone} 无效`)
  }
  if (!fingerprint.language) {
    add('LANGUAGE_REQUIRED', 'error', 'fingerprint.language', '需要设置浏览器主语言')
  }
  if (!fingerprint.acceptLanguages) {
    add('ACCEPT_LANGUAGE_REQUIRED', 'error', 'fingerprint.acceptLanguages', '需要设置接受语言列表')
  } else if (fingerprint.language && primaryLanguage(fingerprint.acceptLanguages) !== fingerprint.language.toLowerCase()) {
    add('LANGUAGE_HEADER_MISMATCH', 'warning', 'fingerprint.acceptLanguages', '接受语言的首项应与浏览器主语言一致')
  }

  if (proxy.enabled) {
    if (!proxy.host || !proxy.port) {
      add('PROXY_INCOMPLETE', 'error', 'proxy', '启用代理后必须填写主机和端口')
    }
    if (fingerprint.webrtcMode === 'off') {
      add('WEBRTC_LEAK_RISK', 'warning', 'fingerprint.webrtcMode', '代理环境建议禁止非代理 UDP，降低 WebRTC 地址泄漏风险')
    }
    if (proxy.ignoreTlsErrors) {
      add('TLS_VERIFICATION_DISABLED', 'warning', 'proxy.ignoreTlsErrors', '已跳过证书认证，只应在代理使用自签名证书时开启')
    }
    if (!geo) {
      add('GEO_UNVERIFIED', 'warning', 'manifest.geo', '尚未通过实际代理出口验证地区画像')
    } else {
      if (geo.proxyIdentity && geo.proxyIdentity !== proxyIdentity(proxy)) {
        add('GEO_PROXY_CHANGED', 'warning', 'manifest.geo', '代理端点已变化，需要重新检测出口地区')
      }
      if (proxy.useSystemProxy && !geo.systemProxy) {
        add('SYSTEM_PROXY_NOT_USED', 'warning', 'proxy.useSystemProxy', '检测时没有解析到可用的系统代理，指定代理可能是直连的')
      }
      if (geo.timezone && geo.timezone !== fingerprint.timezone) {
        add('GEO_TIMEZONE_MISMATCH', 'warning', 'fingerprint.timezone', `当前时区与出口建议 ${geo.timezone} 不一致`)
      }
      if (geo.language && geo.language.toLowerCase() !== fingerprint.language.toLowerCase()) {
        add('GEO_LANGUAGE_MISMATCH', 'warning', 'fingerprint.language', `当前语言与出口建议 ${geo.language} 不一致`)
      }
      if (geo.language && primaryLanguage(fingerprint.acceptLanguages) !== geo.language.toLowerCase()) {
        add('GEO_ACCEPT_LANGUAGE_MISMATCH', 'warning', 'fingerprint.acceptLanguages', '接受语言首项与出口地区建议不一致')
      }
    }
  }

  const status = issues.some((issue) => issue.severity === 'error')
    ? 'error'
    : issues.some((issue) => issue.severity === 'warning')
      ? 'warning'
      : 'ready'
  return { status, issues }
}

function identityOf(fingerprint, network, geo) {
  return JSON.stringify({
    fingerprint,
    network,
    geo: geo
      ? {
          ip: geo.ip,
          countryCode: geo.countryCode,
          timezone: geo.timezone,
          language: geo.language,
          acceptLanguages: geo.acceptLanguages,
          systemProxy: geo.systemProxy
        }
      : null
  })
}

export function withProfileManifest(profile, options = {}) {
  const now = options.now || new Date().toISOString()
  const normalized = normalizeProfile(profile)
  const previous = options.previousManifest ?? profile?.manifest
  const hasOptionGeo = Object.prototype.hasOwnProperty.call(options, 'geo')
  const hasProfileGeo = Object.prototype.hasOwnProperty.call(profile?.manifest || {}, 'geo')
  const inheritedGeo = normalizeGeo(
    hasOptionGeo ? options.geo : hasProfileGeo ? profile.manifest.geo : previous?.geo
  )
  const proxyChanged = Boolean(previous?.network?.proxyIdentity) &&
    previous.network.proxyIdentity !== proxyIdentity(normalized.proxy)
  const currentProxyIdentity = proxyIdentity(normalized.proxy)
  const geoMatchesProxy = !proxyChanged || inheritedGeo?.proxyIdentity === currentProxyIdentity
  const fingerprint = {
    seed: normalized.fingerprint.seed,
    platform: normalized.fingerprint.platform,
    platformVersion: clean(normalized.fingerprint.platformVersion),
    brand: normalized.fingerprint.brand,
    brandVersion: clean(normalized.fingerprint.brandVersion),
    hardwareConcurrency: normalized.fingerprint.hardwareConcurrency,
    language: normalized.fingerprint.language,
    acceptLanguages: normalized.fingerprint.acceptLanguages,
    timezone: normalized.fingerprint.timezone,
    webrtcMode: normalized.fingerprint.webrtcMode
  }
  const network = {
    proxyEnabled: normalized.proxy.enabled,
    proxyIdentity: proxyIdentity(normalized.proxy),
    useSystemProxy: normalized.proxy.useSystemProxy,
    ignoreTlsErrors: normalized.proxy.ignoreTlsErrors
  }
  const hasOptionHealth = Object.prototype.hasOwnProperty.call(options, 'proxyHealth')
  const hasProfileHealth = Object.prototype.hasOwnProperty.call(profile?.manifest || {}, 'proxyHealth')
  const inheritedHealth = hasOptionHealth
    ? options.proxyHealth
    : hasProfileHealth
      ? profile.manifest.proxyHealth
      : previous?.proxyHealth
  const healthMatchesProxy = !proxyChanged || inheritedHealth?.proxyIdentity === currentProxyIdentity
  const resetProxyState = proxyChanged && !geoMatchesProxy && !healthMatchesProxy
  const geo = normalized.proxy.enabled && geoMatchesProxy ? inheritedGeo : null
  const proxyHealth = normalizeProxyHealth(
    resetProxyState ? null : inheritedHealth,
    resetProxyState ? null : geo,
    currentProxyIdentity
  )
  const previousIdentity = previous
    ? identityOf(previous.fingerprint, previous.network, normalizeGeo(previous.geo))
    : ''
  const nextIdentity = identityOf(fingerprint, network, geo)
  const identityChanged = previousIdentity !== nextIdentity
  const previousRevision = Number(previous?.revision) || 0
  const consistency = validateProfileConsistency(normalized, geo)

  return {
    ...normalized,
    manifest: {
      schemaVersion: PROFILE_MANIFEST_VERSION,
      revision: previousRevision ? previousRevision + (identityChanged ? 1 : 0) : 1,
      createdAt: clean(previous?.createdAt) || now,
      updatedAt: identityChanged ? now : clean(previous?.updatedAt) || now,
      fingerprint,
      network,
      geo,
      proxyHealth,
      consistency: { ...consistency, checkedAt: now }
    }
  }
}

export function geoConfirmation(profile, geo) {
  const normalizedGeo = normalizeGeo(geo)
  const previousGeo = normalizeGeo(profile?.manifest?.geo)
  if (!normalizedGeo) return { required: false, reasons: [] }
  const reasons = []
  if (!previousGeo) reasons.push('首次记录代理出口画像')
  else {
    if (previousGeo.proxyIdentity !== normalizedGeo.proxyIdentity) reasons.push('代理端点发生变化')
    if (previousGeo.ip !== normalizedGeo.ip) reasons.push(`出口 IP 变为 ${normalizedGeo.ip}`)
    if (previousGeo.systemProxy !== normalizedGeo.systemProxy) {
      reasons.push(normalizedGeo.systemProxy ? '已启用系统代理前置链路' : '系统代理前置链路未生效')
    }
  }
  if (profile?.fingerprint?.timezone !== normalizedGeo.timezone) reasons.push(`时区调整为 ${normalizedGeo.timezone}`)
  if (String(profile?.fingerprint?.language || '').toLowerCase() !== normalizedGeo.language.toLowerCase()) {
    reasons.push(`语言调整为 ${normalizedGeo.language}`)
  }
  if (clean(profile?.fingerprint?.acceptLanguages) !== normalizedGeo.acceptLanguages) {
    reasons.push(`接受语言调整为 ${normalizedGeo.acceptLanguages}`)
  }
  return { required: reasons.length > 0, reasons }
}

export function applyGeoToProfile(profile, geo, now) {
  const normalizedGeo = normalizeGeo(geo)
  if (!normalizedGeo) return withProfileManifest(profile, { now })
  const next = {
    ...profile,
    fingerprint: {
      ...(profile.fingerprint || {}),
      timezone: normalizedGeo.timezone,
      language: normalizedGeo.language,
      acceptLanguages: normalizedGeo.acceptLanguages
    },
    manifest: { ...(profile.manifest || {}), geo: normalizedGeo }
  }
  return withProfileManifest(next, { previousManifest: profile.manifest, geo: normalizedGeo, now })
}
