// 指纹默认值与随机生成工具。GPU / Canvas / WebGL / 音频等由内核根据 seed 自动派生,
// 这里只负责生成一个自洽的“可读”配置(平台、品牌、时区、语言、CPU 核心等)。

const PLATFORMS = ['windows', 'macos', 'linux']

// 常见平台版本(用于 --fingerprint-platform-version)
const PLATFORM_VERSIONS = {
  windows: ['10.0.0', '15.0.0'],
  macos: ['13.6.0', '14.5.0', '15.2.0'],
  linux: ['6.6.0', '6.8.0']
}

const BRANDS = ['Chrome', 'Edge']

// 常见 CPU 核心数(真实设备的分布)
const HARDWARE_CONCURRENCY = [4, 6, 8, 12, 16]

// 常见语言 + 对应默认时区,保证语言/时区自洽
const LOCALES = [
  { language: 'en-US', accept: 'en-US,en', timezone: 'America/New_York' },
  { language: 'en-US', accept: 'en-US,en', timezone: 'America/Los_Angeles' },
  { language: 'en-GB', accept: 'en-GB,en', timezone: 'Europe/London' },
  { language: 'zh-CN', accept: 'zh-CN,zh', timezone: 'Asia/Shanghai' },
  { language: 'zh-TW', accept: 'zh-TW,zh', timezone: 'Asia/Taipei' },
  { language: 'ja-JP', accept: 'ja-JP,ja', timezone: 'Asia/Tokyo' },
  { language: 'de-DE', accept: 'de-DE,de', timezone: 'Europe/Berlin' },
  { language: 'fr-FR', accept: 'fr-FR,fr', timezone: 'Europe/Paris' }
]

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

// 32 位无符号整数种子
export function randomSeed() {
  return Math.floor(Math.random() * 0xffffffff)
}

// 生成一份随机但自洽的指纹配置
export function randomFingerprint() {
  const platform = pick(PLATFORMS)
  const locale = pick(LOCALES)
  return {
    seed: randomSeed(),
    platform,
    platformVersion: pick(PLATFORM_VERSIONS[platform]),
    brand: pick(BRANDS),
    brandVersion: '',
    hardwareConcurrency: pick(HARDWARE_CONCURRENCY),
    language: locale.language,
    acceptLanguages: locale.accept,
    timezone: locale.timezone,
    webrtcMode: 'disable_non_proxied_udp' // disable_non_proxied_udp | off
  }
}

export const OPTIONS = {
  platforms: PLATFORMS,
  platformVersions: PLATFORM_VERSIONS,
  brands: BRANDS,
  hardwareConcurrency: HARDWARE_CONCURRENCY,
  locales: LOCALES
}
