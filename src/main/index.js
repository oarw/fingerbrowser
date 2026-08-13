import { app, shell, BrowserWindow, ipcMain, dialog, screen } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { loadProfiles, saveProfiles, loadSettings, saveSettings } from './store.js'
import { launch, stop, stopAll, runningIds } from './launcher.js'
import { randomFingerprint, randomSeed, OPTIONS } from './fingerprint.js'
import { detectGeo } from './geo.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

let mainWindow = null

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => mainWindow.show())

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function notifyRunning() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('profiles:running-changed', runningIds())
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => stopAll())

// 计算平铺网格:根据数量与可用工作区,返回每个窗口的位置与大小
function computeGrid(count) {
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

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

function registerIpc() {
  ipcMain.handle('profiles:list', () => loadProfiles())

  ipcMain.handle('profiles:save', (_e, profile) => {
    const profiles = loadProfiles()
    const now = Date.now()
    if (profile.id) {
      const idx = profiles.findIndex((p) => p.id === profile.id)
      if (idx >= 0) {
        profiles[idx] = { ...profiles[idx], ...profile, updatedAt: now }
      } else {
        profiles.push({ ...profile, updatedAt: now, createdAt: now })
      }
    } else {
      profile.id = uuidv4()
      profile.createdAt = now
      profile.updatedAt = now
      profiles.push(profile)
    }
    saveProfiles(profiles)
    return profile
  })

  ipcMain.handle('profiles:delete', (_e, id) => {
    const profiles = loadProfiles().filter((p) => p.id !== id)
    saveProfiles(profiles)
    return true
  })

  ipcMain.handle('profiles:launch', async (_e, id) => {
    const profile = loadProfiles().find((p) => p.id === id)
    if (!profile) throw new Error('环境不存在')
    const settings = loadSettings()
    const result = await launch(profile, settings.kernelPath, () => notifyRunning())
    notifyRunning()
    return result
  })

  // 批量启动;tile=true 时按网格平铺窗口
  ipcMain.handle('profiles:launch-batch', async (_e, ids, tile) => {
    const all = loadProfiles()
    const settings = loadSettings()
    const targets = ids
      .map((id) => all.find((p) => p.id === id))
      .filter(Boolean)
      .filter((p) => !runningIds().includes(p.id))

    const bounds = tile ? computeGrid(targets.length) : []
    const results = []
    for (let i = 0; i < targets.length; i++) {
      try {
        await launch(targets[i], settings.kernelPath, () => notifyRunning(), tile ? bounds[i] : undefined)
        results.push({ id: targets[i].id, ok: true })
      } catch (e) {
        results.push({ id: targets[i].id, ok: false, error: e.message || String(e) })
      }
      notifyRunning()
      await delay(400) // 错开启动,避免瞬时资源争用
    }
    return results
  })

  ipcMain.handle('profiles:stop', async (_e, id) => {
    const ok = await stop(id)
    notifyRunning()
    return ok
  })

  ipcMain.handle('profiles:running', () => runningIds())

  ipcMain.handle('settings:get', () => loadSettings())
  ipcMain.handle('settings:set', (_e, settings) => {
    saveSettings(settings)
    return loadSettings()
  })

  ipcMain.handle('fingerprint:random', () => randomFingerprint())
  ipcMain.handle('fingerprint:random-seed', () => randomSeed())
  ipcMain.handle('fingerprint:options', () => OPTIONS)

  ipcMain.handle('geo:detect', (_e, proxy) => detectGeo(proxy))

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
