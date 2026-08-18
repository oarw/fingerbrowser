// 启动引擎:把一个环境配置翻译成 fingerprint-chromium 的命令行参数并拉起进程。
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { access, mkdir } from 'node:fs/promises'
import { profileDataDir } from './store.js'
import { needsBridge, startBridge, stopBridge, stopAllBridges } from './proxyBridge.js'

const execFileAsync = promisify(execFile)

// 记录正在启动及运行的环境，防止快速双击创建重复进程和泄漏代理桥接。
const launching = new Set()
const running = new Map()
let stoppingAll = false

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
    const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type === 'https' ? 'https' : 'http'
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

// Chromium 会派生 renderer/GPU 等子进程。Windows 下递归结束进程树，
// 避免管理器显示已关闭但后台仍残留内核进程。
async function terminateChild(child) {
  if (!child || !child.pid) return
  if (process.platform === 'win32') {
    try {
      await execFileAsync('taskkill', ['/pid', String(child.pid), '/t'], {
        windowsHide: true,
        timeout: 5000
      })
      return
    } catch {
      try {
        await execFileAsync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
          windowsHide: true,
          timeout: 5000
        })
        return
      } catch {
        // 进程可能已经自行退出，继续走通用路径。
      }
    }
  }
  try {
    child.kill()
  } catch {
    // ignore
  }
}

// 启动一个环境;onExit(id) 在进程退出时回调,用于通知渲染进程刷新状态
export async function launch(profile, kernelPath, onExit, windowBounds, networkOptions = {}) {
  if (stoppingAll) throw new Error('应用正在退出，不能启动环境')
  try {
    if (!kernelPath) throw new Error()
    await access(kernelPath)
  } catch {
    throw new Error('内核路径未设置或文件不存在,请在“设置”中指定 fingerprint-chromium 的 chrome(.exe) 路径')
  }
  if (running.has(profile.id) || launching.has(profile.id)) {
    throw new Error('该环境已在运行中')
  }

  launching.add(profile.id)

  try {
    const userDataDir = profileDataDir(profile.id)
    await mkdir(userDataDir, { recursive: true })

    // 认证、SOCKS5、HTTPS 或系统代理串联统一走本地桥接。
    let proxyServerUrl = ''
    if (needsBridge(profile.proxy)) {
      proxyServerUrl = await startBridge(profile.id, profile.proxy, networkOptions)
    }

    if (stoppingAll) {
      await stopBridge(profile.id)
      throw new Error('应用正在退出，已取消启动')
    }

    const args = buildArgs(profile, userDataDir, proxyServerUrl, windowBounds)
    let child
    try {
      child = spawn(kernelPath, args, {
        detached: false,
        stdio: 'ignore',
        windowsHide: true
      })
    } catch (e) {
      await stopBridge(profile.id)
      throw e
    }

    let cleanupPromise
    const cleanup = () => {
      if (!cleanupPromise) {
        cleanupPromise = (async () => {
          running.delete(profile.id)
          await stopBridge(profile.id)
          if (onExit) onExit(profile.id)
        })()
      }
      return cleanupPromise
    }

    running.set(profile.id, { child, cleanup })
    child.once('exit', cleanup)
    child.once('error', cleanup)

    // spawn() 的启动错误通过异步 error 事件上报，必须传回 IPC 调用方。
    try {
      await new Promise((resolve, reject) => {
        const onSpawn = () => {
          child.removeListener('error', onError)
          resolve()
        }
        const onError = (error) => {
          child.removeListener('spawn', onSpawn)
          reject(error)
        }
        child.once('spawn', onSpawn)
        child.once('error', onError)
      })
    } catch (error) {
      await cleanup()
      throw error
    }

    return { pid: child.pid, args }
  } finally {
    launching.delete(profile.id)
  }
}

export async function stop(id) {
  const entry = running.get(id)
  if (!entry) return false
  running.delete(id)
  await terminateChild(entry.child)
  await entry.cleanup()
  return true
}

export async function stopAll() {
  stoppingAll = true
  const entries = [...running.values()]
  running.clear()
  await Promise.all(entries.map(async (entry) => {
    await terminateChild(entry.child)
    await entry.cleanup()
  }))
  await stopAllBridges()
}
