// 本地持久化:环境列表与应用设置,存放在 userData 目录下的 JSON 文件。
import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const dataDir = app.getPath('userData')
const profilesFile = join(dataDir, 'profiles.json')
const settingsFile = join(dataDir, 'settings.json')

// 每个环境的独立浏览器数据目录(物理隔离 cookie/缓存/存储)
export const profilesRoot = join(dataDir, 'profiles')

function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback
    return JSON.parse(readFileSync(file, 'utf-8'))
  } catch {
    return fallback
  }
}

function writeJson(file, data) {
  ensureDir(dataDir)
  writeFileSync(file, JSON.stringify(data, null, 2), 'utf-8')
}

export function loadProfiles() {
  return readJson(profilesFile, [])
}

export function saveProfiles(profiles) {
  writeJson(profilesFile, profiles)
}

const DEFAULT_SETTINGS = {
  kernelPath: '', // fingerprint-chromium 的 chrome(.exe) 路径
  defaultStartupUrl: 'https://browserleaks.com/canvas'
}

export function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...readJson(settingsFile, {}) }
}

export function saveSettings(settings) {
  writeJson(settingsFile, settings)
}

// 单个环境的数据目录
export function profileDataDir(id) {
  return join(profilesRoot, id)
}
