import { app, shell, BrowserWindow, clipboard, ipcMain, dialog, net, screen, session } from 'electron'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { loadProfiles, saveProfiles, loadSettings, saveSettings } from './store.js'
import { launch, stop, stopAll, runningIds } from './launcher.js'
import { randomFingerprint, randomSeed, OPTIONS } from './fingerprint.js'
import { KernelManager, MANAGED_KERNEL } from './kernelManager.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow = null
let runningNotifyTimer = null
let lastRunningSignature = ''
let shutdownPromise = null
let isQuitting = false
let kernelManager = null

const gotSingleInstanceLock = app.requestSingleInstanceLock()

const SMOKE_PROFILES = [
  {
    id: 'smoke-us',
    name: 'Amazon-US-01',
    group: '电商账号',
    tags: ['美国', '主号'],
    remark: '已登录,下次检查广告账户',
    startupUrl: '',
    fingerprint: {
      seed: 38410291,
      platform: 'windows',
      brand: 'Chrome',
      hardwareConcurrency: 8,
      timezone: 'America/New_York',
      language: 'en-US'
    },
    proxy: { enabled: true, type: 'http', host: 'us.proxy.local', port: '8080' }
  },
  {
    id: 'smoke-jp',
    name: 'TikTok-JP-02',
    group: '内容账号',
    tags: ['日本', '待养号'],
    remark: '完成头像和简介',
    startupUrl: '',
    fingerprint: {
      seed: 91024472,
      platform: 'windows',
      brand: 'Chrome',
      hardwareConcurrency: 4,
      timezone: 'Asia/Tokyo',
      language: 'ja-JP'
    },
    proxy: { enabled: true, type: 'socks5', host: 'jp.proxy.local', port: '1080' }
  },
  {
    id: 'smoke-cn',
    name: 'Research-CN',
    group: '测试环境',
    tags: ['本机'],
    remark: '',
    startupUrl: '',
    fingerprint: {
      seed: 72468103,
      platform: 'windows',
      brand: 'Edge',
      hardwareConcurrency: 12,
      timezone: 'Asia/Shanghai',
      language: 'zh-CN'
    },
    proxy: { enabled: false, type: 'http', host: '', port: '' }
  }
]

function shutdown() {
  if (!shutdownPromise) {
    shutdownPromise = Promise.all([stopAll(), kernelManager?.shutdown()]).finally(() => {
      shutdownPromise = null
    })
  }
  return shutdownPromise
}

function createWindow() {
  const windowIcon = app.isPackaged
    ? join(process.resourcesPath, 'icon.png')
    : join(__dirname, '../../build/icon.png')
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#eef3f5',
    icon: windowIcon,
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      nodeIntegration: false,
      contextIsolation: true,
      // 当前 preload 使用 ESM + externalizeDepsPlugin，迁移到 sandbox 需要先改为单 bundle。
      sandbox: false,
      spellcheck: false,
      enableWebSQL: false,
      v8CacheOptions: 'bypassHeatCheck'
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) void shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env.FINGERBROWSER_SMOKE_TEST === '1') {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const screenshotPath = process.env.FINGERBROWSER_SMOKE_SCREENSHOT
        if (!screenshotPath) throw new Error('FINGERBROWSER_SMOKE_SCREENSHOT is not set')

        const capture = async (path) => {
          const image = await mainWindow.webContents.capturePage()
          await writeFile(path, image.toPNG())
        }
        const click = (target) =>
          mainWindow.webContents.executeJavaScript(
            `document.querySelector('[data-smoke="${target}"]')?.click()`
          )
        const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
        const parsed = parse(screenshotPath)

        await wait(80)
        const launchVisible = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.launch-screen') && document.querySelector('.launch-logo'))`
        )
        if (!launchVisible) throw new Error('custom launch screen was not rendered')
        await capture(join(parsed.dir, `${parsed.name}-launch${parsed.ext}`))
        await wait(1720)

        const launchDismissed = await mainWindow.webContents.executeJavaScript(
          `!document.querySelector('.launch-screen')`
        )
        if (!launchDismissed) throw new Error('custom launch screen did not dismiss')

        const hasBridge = await mainWindow.webContents.executeJavaScript(
          `Boolean(window.api && typeof window.api.listProfiles === 'function')`
        )
        if (!hasBridge) throw new Error('preload bridge window.api is unavailable')

        await click('profiles')
        await wait(500)
        const profileRows = await mainWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.profile-table tbody tr').length`
        )
        if (profileRows !== SMOKE_PROFILES.length) {
          throw new Error(`profile workspace rendered ${profileRows} rows; expected ${SMOKE_PROFILES.length}`)
        }
        await capture(screenshotPath)
        await click('settings')
        await wait(500)
        await capture(join(parsed.dir, `${parsed.name}-settings${parsed.ext}`))
        await click('kernel-log')
        await wait(300)
        const installLogVisible = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('.install-log-panel') && document.querySelector('.install-log-viewer, .install-log-empty'))`
        )
        if (!installLogVisible) throw new Error('kernel install log panel did not open')
        await capture(join(parsed.dir, `${parsed.name}-settings-log${parsed.ext}`))
        await click('profiles')
        await wait(100)
        await click('create')
        await wait(500)
        const seedGenerated = await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.seed-summary strong')?.textContent?.trim() !== '未生成'`
        )
        if (!seedGenerated) throw new Error('profile editor did not generate a fingerprint seed')
        await capture(join(parsed.dir, `${parsed.name}-editor${parsed.ext}`))
        app.exit(0)
      } catch (error) {
        console.error('Electron smoke capture failed:', error)
        app.exit(1)
      }
    })
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function notifyRunning() {
  if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
  const ids = runningIds()
  const signature = ids.join('\u0000')
  if (signature === lastRunningSignature) return
  lastRunningSignature = signature
  mainWindow.webContents.send('profiles:running-changed', ids)
}

function scheduleRunningNotify() {
  if (runningNotifyTimer) return
  runningNotifyTimer = setImmediate(() => {
    runningNotifyTimer = null
    notifyRunning()
  })
}

if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })

  app.whenReady().then(() => {
    kernelManager = new KernelManager(join(app.getPath('userData'), 'kernels'), {
      fetch: (url, options) => net.fetch(url, options),
      resolveProxy: (url) => session.defaultSession.resolveProxy(url),
      networkLabel: 'Electron net.fetch (Chromium network stack)'
    })
    kernelManager.onProgress((progress) => {
      if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return
      mainWindow.webContents.send('kernel:progress', progress)
    })
    registerIpc()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  isQuitting = true
  event.preventDefault()
  void shutdown().finally(() => app.quit())
})

// 计算平铺网格:根据数量与可用工作区,返回每个窗口的位置与大小
function computeGrid(count) {
  if (count <= 0) return []
  const { workArea } = screen.getPrimaryDisplay()
  const cols = Math.ceil(Math.sqrt(count))
  const rows = Math.ceil(count / cols)
  const cellW = Math.floor(workArea.width / cols)
  const cellH = Math.floor(workArea.height / rows)
  const bounds = []
  for (let i = 0; i < count; i++) {
    const c = i % cols
    const r = Math.floor(i / cols)
    bounds.push({
      x: workArea.x + c * cellW,
      y: workArea.y + r * cellH,
      width: cellW,
      height: cellH
    })
  }
  return bounds
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function registerIpc() {
  ipcMain.handle('profiles:list', async () => {
    const profiles = await loadProfiles()
    if (process.env.FINGERBROWSER_SMOKE_TEST === '1' && profiles.length === 0) return SMOKE_PROFILES
    return profiles
  })

  ipcMain.handle('profiles:save', async (_e, profile) => {
    const profiles = await loadProfiles()
    const now = Date.now()
    if (profile.id) {
      const idx = profiles.findIndex((p) => p.id === profile.id)
      if (idx >= 0) {
        profiles[idx] = { ...profiles[idx], ...profile, updatedAt: now }
      } else {
        profiles.push({ ...profile, updatedAt: now, createdAt: now })
      }
    } else {
      profile.id = randomUUID()
      profile.createdAt = now
      profile.updatedAt = now
      profiles.push(profile)
    }
    await saveProfiles(profiles)
    return profile
  })

  ipcMain.handle('profiles:delete', async (_e, id) => {
    const profiles = (await loadProfiles()).filter((p) => p.id !== id)
    await saveProfiles(profiles)
    return true
  })

  ipcMain.handle('profiles:launch', async (_e, id) => {
    const profile = (await loadProfiles()).find((p) => p.id === id)
    if (!profile) throw new Error('环境不存在')
    const settings = await loadSettings()
    const target = { ...profile, startupUrl: profile.startupUrl || settings.defaultStartupUrl }
    const result = await launch(target, settings.kernelPath, () => scheduleRunningNotify())
    notifyRunning()
    return result
  })

  // 批量启动;tile=true 时按网格平铺窗口
  ipcMain.handle('profiles:launch-batch', async (_e, ids, tile) => {
    const [all, settings] = await Promise.all([loadProfiles(), loadSettings()])
    const runningSet = new Set(runningIds())
    const profileById = new Map(all.map((profile) => [profile.id, profile]))
    const targets = [...new Set(Array.isArray(ids) ? ids : [])]
      .map((id) => profileById.get(id))
      .filter(Boolean)
      .filter((p) => !runningSet.has(p.id))

    const bounds = tile ? computeGrid(targets.length) : []
    const results = Array(targets.length)
    let nextIndex = 0
    const workerCount = Math.min(2, targets.length)
    const worker = async () => {
      while (true) {
        const i = nextIndex++
        if (i >= targets.length) return
        try {
          await launch(
            { ...targets[i], startupUrl: targets[i].startupUrl || settings.defaultStartupUrl },
            settings.kernelPath,
            () => scheduleRunningNotify(),
            tile ? bounds[i] : undefined
          )
          results[i] = { id: targets[i].id, ok: true }
        } catch (e) {
          results[i] = { id: targets[i].id, ok: false, error: e.message || String(e) }
        }
        scheduleRunningNotify()
        // 两路并发 + 短间隔，减少 CPU/磁盘尖峰，同时显著快于原先的单路 400ms。
        if (nextIndex < targets.length) await delay(250)
      }
    }
    await Promise.all(Array.from({ length: workerCount }, worker))
    notifyRunning()
    return results
  })

  ipcMain.handle('profiles:stop', async (_e, id) => {
    const ok = await stop(id)
    notifyRunning()
    return ok
  })

  ipcMain.handle('profiles:running', () => runningIds())

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', async (_e, settings) => {
    await saveSettings({ ...(await loadSettings()), ...settings })
    return loadSettings()
  })

  ipcMain.handle('kernel:status', async () => {
    const settings = await loadSettings()
    return kernelManager.getStatus(settings.kernelPath)
  })

  ipcMain.handle('kernel:install', async () => {
    try {
      const kernelPath = await kernelManager.install()
      const settings = await loadSettings()
      await saveSettings({
        ...settings,
        kernelPath,
        managedKernelVersion: MANAGED_KERNEL.version
      })
      return { ok: true, status: await kernelManager.getStatus(kernelPath) }
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
        progress: kernelManager.progress
      }
    }
  })

  ipcMain.handle('kernel:cancel', () => kernelManager.cancel())
  ipcMain.handle('kernel:open-directory', () => shell.openPath(kernelManager.baseDir))
  ipcMain.handle('kernel:open-source', () => shell.openExternal(MANAGED_KERNEL.sourceUrl))
  ipcMain.handle('kernel:get-log', () => kernelManager.getLog())
  ipcMain.handle('kernel:clear-log', () => kernelManager.clearLog())
  ipcMain.handle('kernel:copy-log', async () => {
    const log = await kernelManager.getLog()
    clipboard.writeText(log.text)
    return true
  })
  ipcMain.handle('kernel:open-log', async () => {
    const path = await kernelManager.ensureLogFile()
    return shell.openPath(path)
  })

  ipcMain.handle('fingerprint:random', () => randomFingerprint())
  ipcMain.handle('fingerprint:random-seed', () => randomSeed())
  ipcMain.handle('fingerprint:options', () => OPTIONS)

  ipcMain.handle('geo:detect', async (_e, proxy) => {
    const { detectGeo } = await import('./geo.js')
    return detectGeo(proxy)
  })

  ipcMain.handle('dialog:pick-kernel', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择 fingerprint-chromium 内核',
      properties: ['openFile'],
      filters: [{ name: 'Chromium', extensions: ['exe', 'app', ''] }]
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })
}
