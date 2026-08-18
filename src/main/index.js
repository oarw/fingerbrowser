import { app, shell, BrowserWindow, clipboard, ipcMain, dialog, Menu, net, screen, session, Tray } from 'electron'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { loadProfiles, saveProfiles, loadSettings, saveSettings } from './store.js'
import { launch, stop, stopAll, runningIds } from './launcher.js'
import { randomFingerprint, randomSeed, OPTIONS } from './fingerprint.js'
import { KernelManager, MANAGED_KERNEL } from './kernelManager.js'
import { migrateLegacyKernelDirectory } from './kernelMigration.js'
import { detectGeo } from './geo.js'
import { parseSystemProxyResult } from './proxyBridge.js'
import {
  applyGeoToProfile,
  geoConfirmation,
  proxyIdentity,
  withProfileManifest
} from './profileManifest.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow = null
let runningNotifyTimer = null
let lastRunningSignature = ''
let shutdownPromise = null
let isQuitting = false
let kernelManager = null
let tray = null
let runInBackground = false
let allowWindowClose = false

const gotSingleInstanceLock = app.requestSingleInstanceLock()

function defaultKernelDirectory() {
  if (!app.isPackaged) return join(app.getPath('userData'), 'kernels')
  return resolve(dirname(app.getPath('exe')), '..', 'FingerBrowserData', 'kernels')
}

function legacyKernelDirectory() {
  return join(dirname(app.getPath('exe')), 'kernels')
}

function normalizeKernelDirectory(value) {
  const directory = typeof value === 'string' ? value.trim() : ''
  return directory ? resolve(directory) : defaultKernelDirectory()
}

async function loadRuntimeSettings() {
  const settings = await loadSettings()
  return { ...settings, kernelDirectory: normalizeKernelDirectory(settings.kernelDirectory) }
}

async function migrateLegacyKernelSettings(settings) {
  if (!app.isPackaged) return settings
  const next = await migrateLegacyKernelDirectory(
    settings,
    legacyKernelDirectory(),
    defaultKernelDirectory()
  )
  if (next !== settings) await saveSettings(next)
  return next
}

async function getRuntimeKernelStatus(configuredPath) {
  const status = await kernelManager.getStatus(configuredPath)
  return {
    ...status,
    directory: kernelManager.baseDir,
    defaultDirectory: defaultKernelDirectory()
  }
}

function appIconPath() {
  return app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(__dirname, '../../build/icon.png')
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function ensureTray() {
  if (tray) return tray
  tray = new Tray(appIconPath())
  tray.setToolTip('FingerBrowser')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示主窗口', click: showMainWindow },
      { type: 'separator' },
      { label: '退出 FingerBrowser', click: () => app.quit() }
    ])
  )
  tray.on('click', showMainWindow)
  return tray
}

function confirmRunningProfilesBeforeQuit() {
  const count = runningIds().length
  if (count === 0) return true
  const options = {
    type: 'warning',
    buttons: ['取消', '关闭并退出'],
    defaultId: 0,
    cancelId: 0,
    title: '仍有指纹环境正在运行',
    message: `还有 ${count} 个指纹环境正在运行`,
    detail: '关闭并退出会停止这些环境及其代理桥接。'
  }
  const choice = mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options)
  return choice === 1
}

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
      if (tray) {
        tray.destroy()
        tray = null
      }
      shutdownPromise = null
    })
  }
  return shutdownPromise
}

function createWindow() {
  const windowIcon = appIconPath()
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
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    if (runInBackground) {
      event.preventDefault()
      ensureTray()
      mainWindow.hide()
      return
    }
    if (!allowWindowClose && runningIds().length > 0) {
      if (!confirmRunningProfilesBeforeQuit()) {
        event.preventDefault()
        return
      }
      allowWindowClose = true
    }
  })
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
        const kernelDirectoryConfigured = await mainWindow.webContents.executeJavaScript(
          `document.querySelector('[data-smoke="kernel-directory"]')?.value?.toLowerCase().endsWith('kernels')`
        )
        if (!kernelDirectoryConfigured) throw new Error('default kernel directory was not configured')
        const backgroundSettingVisible = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-smoke="run-background"]'))`
        )
        if (!backgroundSettingVisible) throw new Error('background setting was not rendered')
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
        const consistencyVisible = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-smoke="profile-consistency"]'))`
        )
        if (!consistencyVisible) throw new Error('profile consistency summary was not rendered')
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
    showMainWindow()
  })

  app.whenReady().then(async () => {
    let settings = await loadSettings()
    settings = await migrateLegacyKernelSettings(settings)
    settings = { ...settings, kernelDirectory: normalizeKernelDirectory(settings.kernelDirectory) }
    runInBackground = Boolean(settings.runInBackground)
    kernelManager = new KernelManager(settings.kernelDirectory, {
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
      showMainWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (isQuitting) return
  if (!allowWindowClose && !confirmRunningProfilesBeforeQuit()) {
    event.preventDefault()
    return
  }
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

async function resolveSystemProxyUrl() {
  try {
    const result = await Promise.race([
      session.defaultSession.resolveProxy('https://ipinfo.io/json'),
      delay(5000).then(() => {
        throw new Error('系统代理解析超时')
      })
    ])
    return parseSystemProxyResult(result)
  } catch {
    return ''
  }
}

function consistencyError(validation) {
  const blocking = validation.issues.filter((issue) => issue.severity === 'error')
  return new Error(`环境一致性检查未通过: ${blocking.map((issue) => issue.message).join('；')}`)
}

async function saveProfileSnapshot(profile, { touchUpdatedAt = false } = {}) {
  const profiles = await loadProfiles()
  const index = profiles.findIndex((item) => item.id === profile.id)
  if (index < 0) return
  profiles[index] = {
    ...profiles[index],
    ...profile,
    ...(touchUpdatedAt ? { updatedAt: Date.now() } : {})
  }
  await saveProfiles(profiles)
}

async function preflightGeo(profile, geoCache, systemProxyUrl = '') {
  const prepared = withProfileManifest(profile)
  const validation = prepared.manifest.consistency
  if (validation.status === 'error') return { profile: prepared, validation }
  if (!prepared.proxy.enabled) return { profile: prepared, validation }

  const credentialKey = createHash('sha256')
    .update(`${prepared.proxy.username}\u0000${prepared.proxy.password}`)
    .digest('hex')
  const key = `${proxyIdentity(prepared.proxy)}|${credentialKey}|${systemProxyUrl}`
  if (!geoCache.has(key)) geoCache.set(key, detectGeo(prepared.proxy, { systemProxyUrl }))
  try {
    const geo = await geoCache.get(key)
    const refreshed = withProfileManifest(prepared, { geo })
    return {
      profile: refreshed,
      validation: refreshed.manifest.consistency,
      geo,
      confirmation: geoConfirmation(prepared, geo)
    }
  } catch (error) {
    return { profile: prepared, validation, geoError: error }
  }
}

function showGeoConfirmation(result, scope = '启动') {
  if (result.validation.status === 'error') throw consistencyError(result.validation)
  if (result.geoError) {
    const choice = dialog.showMessageBoxSync(mainWindow, {
      type: 'warning',
      buttons: [`取消${scope}`, '仍然启动'],
      defaultId: 0,
      cancelId: 0,
      title: '无法验证代理出口',
      message: `GeoIP 检测失败，无法确认${scope}环境的出口地区`,
      detail: result.geoError.message || String(result.geoError)
    })
    if (choice !== 1) throw new Error(`已取消${scope}`)
    return result.profile
  }
  if (!result.confirmation?.required) return result.profile

  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: [`取消${scope}`, '应用地区并启动'],
    defaultId: 0,
    cancelId: 0,
    title: '代理出口画像发生变化',
    message: `检测到${scope}环境的代理出口画像需要更新`,
    detail: result.confirmation.reasons.join('、')
  })
  if (choice !== 1) throw new Error(`已取消${scope}`)
  return applyGeoToProfile(result.profile, result.geo)
}

function registerIpc() {
  ipcMain.handle('profiles:list', async () => {
    const profiles = await loadProfiles()
    if (process.env.FINGERBROWSER_SMOKE_TEST === '1' && profiles.length === 0) {
      return SMOKE_PROFILES.map((profile) => withProfileManifest(profile))
    }
    const migrated = profiles.map((profile) => withProfileManifest(profile))
    if (profiles.some((profile, index) => profile.manifest?.schemaVersion !== migrated[index].manifest.schemaVersion)) {
      await saveProfiles(migrated)
    }
    return migrated
  })

  ipcMain.handle('profiles:save', async (_e, profile) => {
    const profiles = await loadProfiles()
    const now = Date.now()
    let savedProfile
    if (profile.id) {
      const idx = profiles.findIndex((p) => p.id === profile.id)
      if (idx >= 0) {
        const merged = { ...profiles[idx], ...profile, updatedAt: now }
        const prepared = withProfileManifest(merged, { previousManifest: profiles[idx].manifest })
        if (prepared.manifest.consistency.status === 'error') throw consistencyError(prepared.manifest.consistency)
        profiles[idx] = prepared
        savedProfile = prepared
      } else {
        const prepared = withProfileManifest({ ...profile, updatedAt: now, createdAt: now }, { now: new Date(now).toISOString() })
        if (prepared.manifest.consistency.status === 'error') throw consistencyError(prepared.manifest.consistency)
        profiles.push(prepared)
        savedProfile = prepared
      }
    } else {
      const prepared = withProfileManifest(
        { ...profile, id: randomUUID(), createdAt: now, updatedAt: now },
        { now: new Date(now).toISOString() }
      )
      if (prepared.manifest.consistency.status === 'error') throw consistencyError(prepared.manifest.consistency)
      profiles.push(prepared)
      savedProfile = prepared
    }
    await saveProfiles(profiles)
    return savedProfile
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
    const systemProxyUrl = await resolveSystemProxyUrl()
    const preflight = await preflightGeo(profile, new Map(), systemProxyUrl)
    const targetProfile = showGeoConfirmation(preflight)
    await saveProfileSnapshot(targetProfile)
    const target = { ...targetProfile, startupUrl: targetProfile.startupUrl || settings.defaultStartupUrl }
    const result = await launch(
      target,
      settings.kernelPath,
      () => scheduleRunningNotify(),
      undefined,
      { systemProxyUrl }
    )
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

    const geoCache = new Map()
    const systemProxyUrl = await resolveSystemProxyUrl()
    const preflight = await Promise.all(
      targets.map((profile) => preflightGeo(profile, geoCache, systemProxyUrl))
    )
    const blocked = preflight.filter((item) => item.validation.status === 'error')
    const changes = preflight.filter((item) => item.confirmation?.required)
    const geoFailures = preflight.filter((item) => item.geoError)
    if (blocked.length || changes.length || geoFailures.length) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['取消批量启动', '应用地区并启动可验证环境'],
        defaultId: 0,
        cancelId: 0,
        title: '批量启动前需要确认',
        message: `有 ${blocked.length + changes.length + geoFailures.length} 个环境需要处理`,
        detail: [
          blocked.length ? `${blocked.length} 个环境存在硬错误，将跳过` : '',
          changes.length ? `${changes.length} 个环境的出口画像需要确认` : '',
          geoFailures.length ? `${geoFailures.length} 个环境无法完成 GeoIP 检测，将跳过` : ''
        ].filter(Boolean).join('；')
      })
      if (choice !== 1) return targets.map((target) => ({ id: target.id, ok: false, error: '已取消批量启动' }))
    }

    const preparedTargets = []
    const preflightById = new Map(preflight.map((item) => [item.profile.id, item]))
    for (const target of targets) {
      const item = preflightById.get(target.id)
      if (item.validation.status === 'error' || item.geoError) continue
      const next = item.confirmation?.required ? applyGeoToProfile(item.profile, item.geo) : item.profile
      await saveProfileSnapshot(next)
      preparedTargets.push(next)
    }

    const bounds = tile ? computeGrid(preparedTargets.length) : []
    const results = Array(targets.length).fill(null).map((_value, index) => ({ id: targets[index].id, ok: false, error: '未通过启动前检查' }))
    let nextIndex = 0
    const workerCount = Math.min(2, preparedTargets.length)
    const worker = async () => {
      while (true) {
        const i = nextIndex++
        if (i >= preparedTargets.length) return
        const target = preparedTargets[i]
        const resultIndex = targets.findIndex((item) => item.id === target.id)
        try {
          await launch(
            { ...target, startupUrl: target.startupUrl || settings.defaultStartupUrl },
            settings.kernelPath,
            () => scheduleRunningNotify(),
            tile ? bounds[i] : undefined,
            { systemProxyUrl }
          )
          results[resultIndex] = { id: target.id, ok: true }
        } catch (e) {
          results[resultIndex] = { id: target.id, ok: false, error: e.message || String(e) }
        }
        scheduleRunningNotify()
        // 两路并发 + 短间隔，减少 CPU/磁盘尖峰，同时显著快于原先的单路 400ms。
        if (nextIndex < preparedTargets.length) await delay(250)
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

  ipcMain.handle('settings:get', () => loadRuntimeSettings())
  ipcMain.handle('settings:set', async (_e, settings) => {
    const current = await loadRuntimeSettings()
    const next = {
      ...current,
      ...settings,
      kernelDirectory: normalizeKernelDirectory(settings.kernelDirectory ?? current.kernelDirectory)
    }
    kernelManager.setBaseDir(next.kernelDirectory)
    runInBackground = Boolean(next.runInBackground)
    await saveSettings(next)
    return next
  })

  ipcMain.handle('kernel:status', async () => {
    const settings = await loadRuntimeSettings()
    return getRuntimeKernelStatus(settings.kernelPath)
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
      return { ok: true, status: await getRuntimeKernelStatus(kernelPath) }
    } catch (error) {
      return {
        ok: false,
        error: error.message || String(error),
        progress: kernelManager.progress
      }
    }
  })

  ipcMain.handle('kernel:cancel', () => kernelManager.cancel())
  ipcMain.handle('kernel:open-directory', async () => {
    try {
      await mkdir(kernelManager.baseDir, { recursive: true })
      return shell.openPath(kernelManager.baseDir)
    } catch (error) {
      return error.message || String(error)
    }
  })
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
  ipcMain.handle('profile:validate', (_e, profile) => withProfileManifest(profile).manifest.consistency)

  ipcMain.handle('geo:detect', async (_e, proxy) => {
    const systemProxyUrl = proxy?.useSystemProxy !== false ? await resolveSystemProxyUrl() : ''
    return detectGeo(proxy, { systemProxyUrl })
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

  ipcMain.handle('dialog:pick-kernel-directory', async () => {
    const settings = await loadRuntimeSettings()
    const result = await dialog.showOpenDialog(mainWindow, {
      title: '选择内核安装目录',
      defaultPath: settings.kernelDirectory,
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || result.filePaths.length === 0) return ''
    return result.filePaths[0]
  })
}
