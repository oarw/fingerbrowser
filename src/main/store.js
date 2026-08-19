// 本地持久化:环境列表与应用设置,存放在 userData 目录下的 JSON 文件。
import { app } from 'electron'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const dataDir = app.getPath('userData')
const profilesFile = join(dataDir, 'profiles.json')
const settingsFile = join(dataDir, 'settings.json')
const templatesFile = join(dataDir, 'templates.json')
const proxyLibraryFile = join(dataDir, 'proxy-library.json')

// 每个环境的独立浏览器数据目录(物理隔离 cookie/缓存/存储)
export const profilesRoot = join(dataDir, 'profiles')

async function readJson(file, fallback) {
  try {
    return JSON.parse(await readFile(file, 'utf-8'))
  } catch {
    return fallback
  }
}

let writeQueue = Promise.resolve()

function writeJson(file, data) {
  const payload = JSON.stringify(data, null, 2)
  const write = writeQueue.catch(() => {}).then(async () => {
    await mkdir(dataDir, { recursive: true })
    await writeFile(file, payload, 'utf-8')
  })
  writeQueue = write
  return write
}

// 模块加载时并行预取，后续 IPC 读取直接命中内存。
let profilesCache = readJson(profilesFile, [])

export function loadProfiles() {
  return profilesCache
}

export function saveProfiles(profiles) {
  profilesCache = Promise.resolve(profiles)
  return writeJson(profilesFile, profiles)
}

let templatesCache = readJson(templatesFile, [])

export function loadTemplates() {
  return templatesCache
}

export function saveTemplates(templates) {
  templatesCache = Promise.resolve(templates)
  return writeJson(templatesFile, templates)
}

let proxyLibraryCache = readJson(proxyLibraryFile, [])

export function loadProxyLibrary() {
  return proxyLibraryCache
}

export function saveProxyLibrary(entries) {
  proxyLibraryCache = Promise.resolve(entries)
  return writeJson(proxyLibraryFile, entries)
}

const DEFAULT_SETTINGS = {
  kernelPath: '', // fingerprint-chromium 的 chrome(.exe) 路径
  kernelDirectory: '', // 空值解析为安装目录同级的持久 kernels,升级时自动迁移旧安装目录
  managedKernelVersion: '',
  runInBackground: false,
  defaultStartupUrl: 'https://browserleaks.com/canvas'
}

let settingsCache = readJson(settingsFile, {})

export async function loadSettings() {
  return { ...DEFAULT_SETTINGS, ...(await settingsCache) }
}

export function saveSettings(settings) {
  settingsCache = Promise.resolve(settings)
  return writeJson(settingsFile, settings)
}

// 单个环境的数据目录
export function profileDataDir(id) {
  return join(profilesRoot, id)
}
