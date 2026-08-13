// 启动引擎:把一个环境配置翻译成 fingerprint-chromium 的命令行参数并拉起进程。
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { profileDataDir } from './store.js'
import { needsBridge, startBridge, stopBridge, stopAllBridges } from './proxyBridge.js'

// 记录正在运行的进程:profileId -> ChildProcess
const running = new Map()

// 把环境配置翻译成内核命令行参数。
// proxyServerUrl:若走本地桥接,这里传入本地代理 url;否则为空,使用环境自身代理。
// windowBounds:可选窗口位置/大小(用于平铺)。
export function buildArgs(profile, userDataDir, proxyServerUrl, windowBounds) {
  const fp = profile.fingerprint || {}
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check'
  ]

  if (fp.seed !== undefined && fp.seed !== null && fp.seed !== '') {
    args.push(`--fingerprint=${fp.seed}`)
  }
  if (fp.platform) args.push(`--fingerprint-platform=${fp.platform}`)
  if (fp.platformVersion) args.push(`--fingerprint-platform-version=${fp.platformVersion}`)
  if (fp.brand) args.push(`--fingerprint-brand=${fp.brand}`)
  if (fp.brandVersion) args.push(`--fingerprint-brand-version=${fp.brandVersion}`)
  if (fp.hardwareConcurrency) args.push(`--fingerprint-hardware-concurrency=${fp.hardwareConcurrency}`)
  if (fp.timezone) args.push(`--timezone=${fp.timezone}`)
  if (fp.language) args.push(`--lang=${fp.language}`)
  if (fp.acceptLanguages) args.push(`--accept-lang=${fp.acceptLanguages}`)

  // WebRTC 策略:默认禁止非代理 UDP,避免真实 IP 泄漏
  if (fp.webrtcMode !== 'off') {
    args.push('--disable-non-proxied-udp')
  }

  // 代理:优先使用桥接后的本地代理;否则用环境自身的无认证代理
  const proxy = profile.proxy
  if (proxyServerUrl) {
    args.push(`--proxy-server=${proxyServerUrl}`)
  } else if (proxy && proxy.enabled && proxy.host && proxy.port) {
    const scheme = proxy.type === 'socks5' ? 'socks5' : 'http'
    args.push(`--proxy-server=${scheme}://${proxy.host}:${proxy.port}`)
  }

  // 窗口平铺
  if (windowBounds) {
    args.push(`--window-position=${windowBounds.x},${windowBounds.y}`)
    args.push(`--window-size=${windowBounds.width},${windowBounds.height}`)
  }

  // 起始页
  if (profile.startupUrl) args.push(profile.startupUrl)

  return args
}

export function isRunning(id) {
  return running.has(id)
}

export function runningIds() {
  return [...running.keys()]
}

// 启动一个环境;onExit(id) 在进程退出时回调,用于通知渲染进程刷新状态
export async function launch(profile, kernelPath, onExit, windowBounds) {
  if (!kernelPath || !existsSync(kernelPath)) {
    throw new Error('内核路径未设置或文件不存在,请在“设置”中指定 fingerprint-chromium 的 chrome(.exe) 路径')
  }
  if (running.has(profile.id)) {
    throw new Error('该环境已在运行中')
  }

  const userDataDir = profileDataDir(profile.id)
  if (!existsSync(userDataDir)) mkdirSync(userDataDir, { recursive: true })

  // 带认证 / SOCKS5 代理走本地桥接
  let proxyServerUrl = ''
  if (needsBridge(profile.proxy)) {
    proxyServerUrl = await startBridge(profile.id, profile.proxy)
  }

  const args = buildArgs(profile, userDataDir, proxyServerUrl, windowBounds)
  let child
  try {
    child = spawn(kernelPath, args, { detached: false, stdio: 'ignore' })
  } catch (e) {
    await stopBridge(profile.id)
    throw e
  }

  running.set(profile.id, child)

  const cleanup = async () => {
    running.delete(profile.id)
    await stopBridge(profile.id)
    if (onExit) onExit(profile.id)
  }
  child.on('exit', cleanup)
  child.on('error', cleanup)

  return { pid: child.pid, args }
}

export async function stop(id) {
  const child = running.get(id)
  if (!child) return false
  try {
    child.kill()
  } catch {
    // ignore
  }
  running.delete(id)
  await stopBridge(id)
  return true
}

export async function stopAll() {
  for (const [, child] of running) {
    try {
      child.kill()
    } catch {
      // ignore
    }
  }
  running.clear()
  await stopAllBridges()
}
