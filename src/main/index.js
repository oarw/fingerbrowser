import { app, shell, BrowserWindow, clipboard, ipcMain, dialog, Menu, net, screen, session, Tray } from 'electron'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { freemem, totalmem } from 'node:os'
import {
  loadProfiles,
  saveProfiles,
  loadSettings,
  saveSettings,
  loadTemplates,
  saveTemplates,
  loadProxyLibrary,
  saveProxyLibrary
} from './store.js'
import { launch, stop, stopAll, runningIds } from './launcher.js'
import { randomFingerprint, randomSeed, OPTIONS } from './fingerprint.js'
import { KernelManager, MANAGED_KERNEL } from './kernelManager.js'
import { migrateLegacyKernelDirectory } from './kernelMigration.js'
import { detectGeo } from './geo.js'
import { parseSystemProxyResult } from './proxyBridge.js'
import { normalizeStartupPolicy, runtimeWithSystemProxy } from './launchPolicy.js'
import { assessLaunchMemory, formatMemory } from './memoryGuard.js'
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
        const sidebarStartedCollapsed = await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.app-shell')?.classList.contains('sidebar-collapsed')`
        )
        if (sidebarStartedCollapsed) {
          await click('sidebar-toggle')
          await wait(250)
        }
        const sidebarExpandedWidth = await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.sidebar')?.getBoundingClientRect().width`
        )
        await click('sidebar-toggle')
        await wait(250)
        const sidebarCollapsedWidth = await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.sidebar')?.getBoundingClientRect().width`
        )
        if (!(sidebarExpandedWidth > sidebarCollapsedWidth && sidebarCollapsedWidth <= 73)) {
          throw new Error(`sidebar did not collapse: ${sidebarExpandedWidth} -> ${sidebarCollapsedWidth}`)
        }
        await capture(join(parsed.dir, `${parsed.name}-sidebar-collapsed${parsed.ext}`))
        await click('sidebar-toggle')
        await wait(250)
        const profileRows = await mainWindow.webContents.executeJavaScript(
          `document.querySelectorAll('.profile-table tbody tr').length`
        )
        if (profileRows !== SMOKE_PROFILES.length) {
          throw new Error(`profile workspace rendered ${profileRows} rows; expected ${SMOKE_PROFILES.length}`)
        }
        await capture(screenshotPath)
        await click('proxy-library')
        await wait(200)
        const proxyLibraryReady = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-smoke="proxy-library-dialog"]'))`
        )
        if (!proxyLibraryReady) throw new Error('proxy library did not render')
        await capture(join(parsed.dir, `${parsed.name}-proxy-library${parsed.ext}`))
        await click('proxy-library-close')
        await wait(100)
        await click('quick-proxy-edit')
        await wait(200)
        const quickProxyReady = await mainWindow.webContents.executeJavaScript(
          `Boolean(document.querySelector('[data-smoke="quick-proxy-dialog"]') && document.querySelector('[data-smoke="quick-proxy-test"]'))`
        )
        if (!quickProxyReady) throw new Error('quick proxy editor did not render')
        await capture(join(parsed.dir, `${parsed.name}-quick-proxy${parsed.ext}`))
        await click('quick-proxy-close')
        await wait(100)
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
        const settingsBottomLayout = await mainWindow.webContents.executeJavaScript(`(() => {
          const scroller = document.querySelector('.settings-content')
          const shell = document.querySelector('.app-shell')
          const sidebar = document.querySelector('.sidebar')
          if (!scroller || !shell || !sidebar) return null
          scroller.scrollTop = scroller.scrollHeight
          const viewportHeight = document.documentElement.clientHeight
          return {
            rootScrollTop: document.scrollingElement.scrollTop,
            shellBottom: Math.round(shell.getBoundingClientRect().bottom),
            sidebarBottom: Math.round(sidebar.getBoundingClientRect().bottom),
            scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
            viewportHeight,
            toggleCopyBackground: getComputedStyle(document.querySelector('.toggle-copy')).backgroundColor
          }
        })()`)
        if (
          !settingsBottomLayout ||
          settingsBottomLayout.rootScrollTop !== 0 ||
          Math.abs(settingsBottomLayout.shellBottom - settingsBottomLayout.viewportHeight) > 1 ||
          Math.abs(settingsBottomLayout.sidebarBottom - settingsBottomLayout.viewportHeight) > 1 ||
          Math.abs(settingsBottomLayout.scrollerBottom - settingsBottomLayout.viewportHeight) > 1 ||
          settingsBottomLayout.toggleCopyBackground !== 'rgba(0, 0, 0, 0)'
        ) {
          throw new Error(`settings bottom layout escaped viewport: ${JSON.stringify(settingsBottomLayout)}`)
        }
        await wait(100)
        await capture(join(parsed.dir, `${parsed.name}-settings-bottom${parsed.ext}`))
        await mainWindow.webContents.executeJavaScript(
          `document.querySelector('.settings-content').scrollTop = 0`
        )
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
        const editorBottomLayout = await mainWindow.webContents.executeJavaScript(`(() => {
          const scroller = document.querySelector('.editor-content')
          const sidebar = document.querySelector('.sidebar')
          if (!scroller || !sidebar) return null
          scroller.scrollTop = scroller.scrollHeight
          const viewportHeight = document.documentElement.clientHeight
          return {
            rootScrollTop: document.scrollingElement.scrollTop,
            sidebarBottom: Math.round(sidebar.getBoundingClientRect().bottom),
            scrollerBottom: Math.round(scroller.getBoundingClientRect().bottom),
            viewportHeight
          }
        })()`)
        if (
          !editorBottomLayout ||
          editorBottomLayout.rootScrollTop !== 0 ||
          Math.abs(editorBottomLayout.sidebarBottom - editorBottomLayout.viewportHeight) > 1 ||
          Math.abs(editorBottomLayout.scrollerBottom - editorBottomLayout.viewportHeight) > 1
        ) {
          throw new Error(`editor bottom layout escaped viewport: ${JSON.stringify(editorBottomLayout)}`)
        }
        await wait(100)
        await capture(join(parsed.dir, `${parsed.name}-editor-bottom${parsed.ext}`))
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

function confirmLaunchMemory(count, scope = '启动') {
  const assessment = assessLaunchMemory(freemem(), totalmem(), count)
  if (assessment.ok) return true
  const choice = dialog.showMessageBoxSync(mainWindow, {
    type: 'warning',
    buttons: [`取消${scope}`, '仍然启动'],
    defaultId: 0,
    cancelId: 0,
    title: '可用内存可能不足',
    message: `${scope} ${count} 个环境可能超出当前可用内存`,
    detail: `当前可用 ${formatMemory(assessment.availableBytes)}；建议至少保留 ${formatMemory(assessment.reserveBytes)} 给系统，并为待启动环境预留 ${formatMemory(assessment.browserBudgetBytes)}。`
  })
  return choice === 1
}

function templateSnapshot(profile) {
  const fingerprint = { ...(profile?.fingerprint || {}) }
  delete fingerprint.seed
  const tags = Array.isArray(profile?.tags)
    ? [...profile.tags]
    : String(profile?.tags || '')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean)
  return {
    group: profile?.group || '',
    tags,
    remark: '',
    startupUrl: profile?.startupUrl || '',
    fingerprint,
    proxy: { ...(profile?.proxy || {}) },
    startupPolicy: normalizeStartupPolicy(profile?.startupPolicy),
    manifest: {
      geo: profile?.manifest?.geo || null,
      proxyHealth: profile?.manifest?.proxyHealth || null
    }
  }
}

function normalizedLibraryProxy(value = {}) {
  const type = ['http', 'https', 'socks5'].includes(value.type) ? value.type : 'http'
  return {
    enabled: true,
    type,
    host: String(value.host || '').trim(),
    port: String(value.port || '').trim(),
    username: String(value.username || '').trim(),
    password: typeof value.password === 'string' ? value.password : '',
    useSystemProxy: value.useSystemProxy !== false,
    ignoreTlsErrors: Boolean(value.ignoreTlsErrors)
  }
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
    const refreshed = withProfileManifest(prepared, {
      geo,
      proxyHealth: { status: 'available', checkedAt: new Date().toISOString(), error: '' }
    })
    return {
      profile: refreshed,
      validation: refreshed.manifest.consistency,
      geo,
      confirmation: geoConfirmation(prepared, geo)
    }
  } catch (error) {
    const unavailable = withProfileManifest(prepared, {
      proxyHealth: {
        status: 'unavailable',
        checkedAt: new Date().toISOString(),
        error: error.message || String(error)
      }
    })
    return { profile: unavailable, validation: unavailable.manifest.consistency, geoError: error }
  }
}

function resolveSinglePreflight(result, scope = '启动') {
  if (result.validation.status === 'error') throw consistencyError(result.validation)
  const policy = normalizeStartupPolicy(result.profile.startupPolicy)
  if (result.geoError) {
    if (policy.proxyFailureAction === 'block') throw new Error('代理检测失败，已按环境策略阻止启动')
    if (policy.proxyFailureAction === 'ask') {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: [`取消${scope}`, '使用系统代理启动'],
        defaultId: 0,
        cancelId: 0,
        title: '代理 IP 不可用',
        message: `无法验证${scope}环境的指定代理`,
        detail: `${result.geoError.message || String(result.geoError)}\n\n继续后仅本次启动改用系统代理，不会覆盖原代理配置。`
      })
      if (choice !== 1) throw new Error(`已取消${scope}`)
    }
    return {
      storedProfile: result.profile,
      runtimeProfile: runtimeWithSystemProxy(result.profile),
      forceSystemProxy: true
    }
  }
  if (!result.confirmation?.required) {
    return { storedProfile: result.profile, runtimeProfile: result.profile, forceSystemProxy: false }
  }

  if (policy.ipChangeAction === 'block') throw new Error('代理出口画像发生变化，已按环境策略阻止启动')
  if (policy.ipChangeAction === 'ask') {
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
  }
  const applied = applyGeoToProfile(result.profile, result.geo)
  return { storedProfile: applied, runtimeProfile: applied, forceSystemProxy: false }
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

  ipcMain.handle('profiles:duplicate', async (_e, id) => {
    const profiles = await loadProfiles()
    const source = profiles.find((profile) => profile.id === id)
    if (!source) throw new Error('环境不存在')
    const now = Date.now()
    const duplicate = withProfileManifest({
      ...source,
      id: randomUUID(),
      name: `${source.name} 副本`,
      fingerprint: { ...(source.fingerprint || {}), seed: randomSeed() },
      manifest: {
        geo: source.manifest?.geo || null,
        proxyHealth: source.manifest?.proxyHealth || null
      },
      createdAt: now,
      updatedAt: now
    }, { now: new Date(now).toISOString() })
    profiles.push(duplicate)
    await saveProfiles(profiles)
    return duplicate
  })

  ipcMain.handle('templates:list', () => loadTemplates())
  ipcMain.handle('templates:save', async (_e, name, profile) => {
    const title = String(name || '').trim()
    if (!title) throw new Error('模板名称不能为空')
    const templates = await loadTemplates()
    const now = Date.now()
    const template = {
      id: randomUUID(),
      name: title,
      profile: templateSnapshot(profile),
      createdAt: now,
      updatedAt: now
    }
    templates.push(template)
    await saveTemplates(templates)
    return template
  })
  ipcMain.handle('templates:delete', async (_e, id) => {
    const templates = (await loadTemplates()).filter((template) => template.id !== id)
    await saveTemplates(templates)
    return true
  })

  ipcMain.handle('proxy-library:list', () => loadProxyLibrary())
  ipcMain.handle('proxy-library:save', async (_e, entry) => {
    const name = String(entry?.name || '').trim()
    const proxy = normalizedLibraryProxy(entry?.proxy)
    if (!name) throw new Error('代理名称不能为空')
    if (!proxy.host || !proxy.port) throw new Error('代理主机和端口不能为空')
    const entries = await loadProxyLibrary()
    const now = Date.now()
    const index = entries.findIndex((item) => item.id === entry?.id)
    const saved = {
      id: index >= 0 ? entries[index].id : randomUUID(),
      name,
      proxy,
      createdAt: index >= 0 ? entries[index].createdAt : now,
      updatedAt: now
    }
    if (index >= 0) entries[index] = saved
    else entries.push(saved)
    await saveProxyLibrary(entries)
    return saved
  })
  ipcMain.handle('proxy-library:delete', async (_e, id) => {
    const entries = (await loadProxyLibrary()).filter((entry) => entry.id !== id)
    await saveProxyLibrary(entries)
    return true
  })
  ipcMain.handle('proxy-library:assign', async (_e, ids, entryId) => {
    const [profiles, entries] = await Promise.all([loadProfiles(), loadProxyLibrary()])
    const entry = entryId ? entries.find((item) => item.id === entryId) : null
    if (entryId && !entry) throw new Error('代理库条目不存在')
    const targetIds = new Set(Array.isArray(ids) ? ids : [])
    let updated = 0
    const next = profiles.map((profile) => {
      if (!targetIds.has(profile.id)) return profile
      const proxy = entry
        ? normalizedLibraryProxy(entry.proxy)
        : { enabled: false, type: 'http', host: '', port: '', username: '', password: '', useSystemProxy: true, ignoreTlsErrors: false }
      updated += 1
      return withProfileManifest(
        {
          ...profile,
          proxy,
          manifest: { ...(profile.manifest || {}), geo: null, proxyHealth: null },
          updatedAt: Date.now()
        },
        { previousManifest: profile.manifest }
      )
    })
    await saveProfiles(next)
    return { updated }
  })

  ipcMain.handle('profiles:launch', async (_e, id) => {
    const profile = (await loadProfiles()).find((p) => p.id === id)
    if (!profile) throw new Error('环境不存在')
    if (runningIds().includes(id)) throw new Error('该环境已在运行中')
    if (!confirmLaunchMemory(1)) throw new Error('可用内存不足，已取消启动')
    const settings = await loadSettings()
    const systemProxyUrl = await resolveSystemProxyUrl()
    const preflight = await preflightGeo(profile, new Map(), systemProxyUrl)
    if (preflight.geoError) await saveProfileSnapshot(preflight.profile)
    const prepared = resolveSinglePreflight(preflight)
    await saveProfileSnapshot(prepared.storedProfile)
    const target = { ...prepared.runtimeProfile, startupUrl: prepared.runtimeProfile.startupUrl || settings.defaultStartupUrl }
    const result = await launch(
      target,
      settings.kernelPath,
      () => scheduleRunningNotify(),
      undefined,
      { systemProxyUrl, forceSystemProxy: prepared.forceSystemProxy }
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

    if (!confirmLaunchMemory(targets.length, '批量启动')) {
      return targets.map((target) => ({ id: target.id, ok: false, error: '可用内存不足，已取消批量启动' }))
    }

    const geoCache = new Map()
    const systemProxyUrl = await resolveSystemProxyUrl()
    const preflight = await Promise.all(
      targets.map((profile) => preflightGeo(profile, geoCache, systemProxyUrl))
    )
    for (const item of preflight) {
      if (item.geoError) await saveProfileSnapshot(item.profile)
    }
    const blocked = preflight.filter((item) => {
      const policy = normalizeStartupPolicy(item.profile.startupPolicy)
      return item.validation.status === 'error' ||
        (item.geoError && policy.proxyFailureAction === 'block') ||
        (item.confirmation?.required && policy.ipChangeAction === 'block')
    })
    const pendingChanges = preflight.filter((item) =>
      item.confirmation?.required && normalizeStartupPolicy(item.profile.startupPolicy).ipChangeAction === 'ask'
    )
    const pendingFallbacks = preflight.filter((item) =>
      item.geoError && normalizeStartupPolicy(item.profile.startupPolicy).proxyFailureAction === 'ask'
    )
    if (pendingChanges.length || pendingFallbacks.length) {
      const choice = dialog.showMessageBoxSync(mainWindow, {
        type: 'warning',
        buttons: ['取消批量启动', '应用策略并继续'],
        defaultId: 0,
        cancelId: 0,
        title: '批量启动前需要确认',
        message: `有 ${pendingChanges.length + pendingFallbacks.length} 个环境需要确认`,
        detail: [
          pendingChanges.length ? `${pendingChanges.length} 个环境将更新出口地区画像` : '',
          pendingFallbacks.length ? `${pendingFallbacks.length} 个环境的指定代理不可用，将仅本次改用系统代理` : '',
          blocked.length ? `${blocked.length} 个环境被一致性检查或启动策略阻止` : ''
        ].filter(Boolean).join('；')
      })
      if (choice !== 1) return targets.map((target) => ({ id: target.id, ok: false, error: '已取消批量启动' }))
    }

    const preparedTargets = []
    const preflightById = new Map(preflight.map((item) => [item.profile.id, item]))
    for (const target of targets) {
      const item = preflightById.get(target.id)
      const policy = normalizeStartupPolicy(item.profile.startupPolicy)
      await saveProfileSnapshot(item.profile)
      if (item.validation.status === 'error') continue
      if (item.geoError) {
        if (policy.proxyFailureAction === 'block') continue
        preparedTargets.push({
          storedProfile: item.profile,
          runtimeProfile: runtimeWithSystemProxy(item.profile),
          forceSystemProxy: true
        })
        continue
      }
      if (item.confirmation?.required && policy.ipChangeAction === 'block') continue
      const next = item.confirmation?.required ? applyGeoToProfile(item.profile, item.geo) : item.profile
      await saveProfileSnapshot(next)
      preparedTargets.push({ storedProfile: next, runtimeProfile: next, forceSystemProxy: false })
    }

    const bounds = tile ? computeGrid(preparedTargets.length) : []
    const results = targets.map((target) => ({ id: target.id, ok: false, error: '未通过启动前检查或已被启动策略阻止' }))
    let nextIndex = 0
    const workerCount = Math.min(2, preparedTargets.length)
    const worker = async () => {
      while (true) {
        const i = nextIndex++
        if (i >= preparedTargets.length) return
        const prepared = preparedTargets[i]
        const target = prepared.runtimeProfile
        const resultIndex = targets.findIndex((item) => item.id === target.id)
        try {
          await launch(
            { ...target, startupUrl: target.startupUrl || settings.defaultStartupUrl },
            settings.kernelPath,
            () => scheduleRunningNotify(),
            tile ? bounds[i] : undefined,
            { systemProxyUrl, forceSystemProxy: prepared.forceSystemProxy }
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
