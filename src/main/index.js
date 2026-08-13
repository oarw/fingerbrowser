import { app, shell, BrowserWindow, ipcMain, dialog } from 'electron'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { v4 as uuidv4 } from 'uuid'
import { loadProfiles, saveProfiles, loadSettings, saveSettings } from './store.js'
import { launch, stop, stopAll, runningIds } from './launcher.js'
import { randomFingerprint, randomSeed, OPTIONS } from './fingerprint.js'

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

  ipcMain.handle('profiles:launch', (_e, id) => {
    const profile = loadProfiles().find((p) => p.id === id)
    if (!profile) throw new Error('环境不存在')
    const settings = loadSettings()
    const result = launch(profile, settings.kernelPath, () => notifyRunning())
    notifyRunning()
    return result
  })

  ipcMain.handle('profiles:stop', (_e, id) => {
    const ok = stop(id)
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
