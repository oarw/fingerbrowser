// 按代理出口 IP 查询地理信息,用于自动填充时区 / 语言。
// 通过(临时匿名的)代理请求 ip-api.com,拿到的即是代理出口的地理位置。
import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain'
import { request, ProxyAgent } from 'undici'
import { buildUpstreamUrl } from './proxyBridge.js'

// 国家/地区 -> 首选语言(用于 --lang / --accept-lang)
const CC_LANG = {
  US: 'en-US', GB: 'en-GB', AU: 'en-AU', CA: 'en-CA', NZ: 'en-NZ', IE: 'en-IE',
  CN: 'zh-CN', TW: 'zh-TW', HK: 'zh-HK', SG: 'zh-SG',
  JP: 'ja-JP', KR: 'ko-KR',
  DE: 'de-DE', AT: 'de-AT', CH: 'de-CH',
  FR: 'fr-FR', BE: 'fr-BE',
  ES: 'es-ES', MX: 'es-MX', AR: 'es-AR', CL: 'es-CL', CO: 'es-CO',
  IT: 'it-IT', PT: 'pt-PT', BR: 'pt-BR',
  RU: 'ru-RU', UA: 'uk-UA', PL: 'pl-PL', NL: 'nl-NL', SE: 'sv-SE',
  NO: 'nb-NO', DK: 'da-DK', FI: 'fi-FI', TR: 'tr-TR', TH: 'th-TH',
  VN: 'vi-VN', ID: 'id-ID', IN: 'en-IN', MY: 'ms-MY', PH: 'en-PH'
}

const API = 'http://ip-api.com/json/?fields=status,message,countryCode,country,timezone,lat,lon,query'

export async function detectGeo(proxy) {
  let localUrl = null
  let dispatcher
  try {
    if (proxy && proxy.enabled && proxy.host && proxy.port) {
      localUrl = await anonymizeProxy(buildUpstreamUrl(proxy))
      dispatcher = new ProxyAgent(localUrl)
    }
    const { statusCode, body } = await request(API, {
      dispatcher,
      headersTimeout: 15000,
      bodyTimeout: 15000
    })
    if (statusCode !== 200) throw new Error(`IP 查询失败 (HTTP ${statusCode})`)
    const data = await body.json()
    if (data.status !== 'success') throw new Error(data.message || 'IP 查询失败')

    const lang = CC_LANG[data.countryCode] || 'en-US'
    return {
      ip: data.query,
      country: data.country,
      countryCode: data.countryCode,
      timezone: data.timezone,
      lat: data.lat,
      lon: data.lon,
      language: lang,
      acceptLanguages: `${lang},${lang.split('-')[0]}`
    }
  } finally {
    if (localUrl) {
      try {
        await closeAnonymizedProxy(localUrl, true)
      } catch {
        // ignore
      }
    }
  }
}
