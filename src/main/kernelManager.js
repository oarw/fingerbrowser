import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { fetch } from 'undici'

const execFileAsync = promisify(execFile)

export const MANAGED_KERNEL = Object.freeze({
  version: '148.0.7778.215',
  label: 'Chromium 148 · Windows x64',
  archiveName: 'ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip',
  downloadUrl:
    'https://github.com/adryfish/fingerprint-chromium/releases/download/148.0.7778.215/ungoogled-chromium_148.0.7778.215-1.1_windows_x64.zip',
  size: 189767686,
  sha256: '9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579',
  sourceUrl: 'https://github.com/adryfish/fingerprint-chromium/releases/tag/148.0.7778.215'
})

const METADATA_FILE = '.fingerbrowser-kernel.json'

async function pathExists(path) {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function fileExists(path) {
  if (!path) return false
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function findChromeExecutable(root) {
  const entries = await readdir(root, { withFileTypes: true })
  const direct = entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === 'chrome.exe')
  if (direct) return join(root, direct.name)

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const found = await findChromeExecutable(join(root, entry.name))
    if (found) return found
  }
  return ''
}

async function expandZip(archivePath, destination) {
  const script =
    '& { param($archive, $destination) Expand-Archive -LiteralPath $archive -DestinationPath $destination -Force }'
  await execFileAsync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      script,
      archivePath,
      destination
    ],
    { windowsHide: true, timeout: 180000, maxBuffer: 1024 * 1024 }
  )
}

export class KernelManager {
  constructor(baseDir, options = {}) {
    this.baseDir = baseDir
    this.kernel = options.kernel || MANAGED_KERNEL
    this.fetch = options.fetch || fetch
    this.expandZip = options.expandZip || expandZip
    this.platform = options.platform || process.platform
    this.installPromise = null
    this.abortController = null
    this.listeners = new Set()
    this.progress = { stage: 'idle', received: 0, total: this.kernel.size, percent: 0 }
  }

  onProgress(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emitProgress(update) {
    this.progress = { ...this.progress, ...update }
    for (const listener of this.listeners) listener(this.progress)
  }

  versionDir() {
    return join(this.baseDir, this.kernel.version)
  }

  archivePath() {
    return join(this.baseDir, 'downloads', `${this.kernel.archiveName}.part`)
  }

  async managedExecutable() {
    const root = this.versionDir()
    try {
      const metadata = JSON.parse(await readFile(join(root, METADATA_FILE), 'utf-8'))
      const candidate = resolve(root, metadata.executable || '')
      const rootPrefix = `${resolve(root)}${sep}`
      if (!candidate.startsWith(rootPrefix) || !(await fileExists(candidate))) return ''
      return candidate
    } catch {
      return ''
    }
  }

  async getStatus(configuredPath = '') {
    const managedPath = await this.managedExecutable()
    const configuredReady = await fileExists(configuredPath)
    return {
      supported: this.platform === 'win32',
      ready: configuredReady,
      source: configuredReady && managedPath && resolve(configuredPath) === resolve(managedPath) ? 'managed' : configuredReady ? 'manual' : 'none',
      configuredPath,
      managed: {
        installed: Boolean(managedPath),
        path: managedPath,
        ...this.kernel
      },
      progress: this.progress
    }
  }

  async install() {
    if (this.platform !== 'win32') throw new Error('当前内置安装仅支持 Windows x64')
    if (this.installPromise) return this.installPromise

    this.installPromise = this.runInstall()
      .catch((error) => {
        if (this.progress.stage !== 'paused') {
          this.emitProgress({ stage: 'error', message: error.message || String(error) })
        }
        throw error
      })
      .finally(() => {
        this.installPromise = null
        this.abortController = null
      })
    return this.installPromise
  }

  cancel() {
    if (!this.abortController) return false
    this.abortController.abort()
    return true
  }

  async shutdown() {
    this.cancel()
    if (this.installPromise) await this.installPromise.catch(() => {})
  }

  async runInstall() {
    const existing = await this.managedExecutable()
    if (existing) {
      this.emitProgress({ stage: 'ready', received: this.kernel.size, percent: 100 })
      return existing
    }

    await mkdir(join(this.baseDir, 'downloads'), { recursive: true })
    const archivePath = this.archivePath()
    let received = 0
    try {
      received = (await stat(archivePath)).size
      if (received > this.kernel.size) {
        await rm(archivePath, { force: true })
        received = 0
      }
    } catch {
      received = 0
    }

    if (received < this.kernel.size) {
      this.abortController = new AbortController()
      const headers = { 'User-Agent': 'FingerBrowser-Kernel-Manager' }
      if (received > 0) headers.Range = `bytes=${received}-`

      this.emitProgress({
        stage: 'downloading',
        received,
        total: this.kernel.size,
        percent: Math.floor((received / this.kernel.size) * 100)
      })

      const response = await this.fetch(this.kernel.downloadUrl, {
        headers,
        redirect: 'follow',
        signal: this.abortController.signal
      })

      if (!response.ok) throw new Error(`内核下载失败:HTTP ${response.status}`)
      const canResume = received > 0 && response.status === 206
      if (!canResume) received = 0

      let lastProgressAt = 0
      const progressStream = new Transform({
        transform: (chunk, _encoding, callback) => {
          received += chunk.length
          const now = Date.now()
          if (now - lastProgressAt >= 120 || received >= this.kernel.size) {
            lastProgressAt = now
            this.emitProgress({
              stage: 'downloading',
              received,
              total: this.kernel.size,
              percent: Math.min(100, Math.floor((received / this.kernel.size) * 100))
            })
          }
          callback(null, chunk)
        }
      })

      try {
        await pipeline(
          Readable.fromWeb(response.body),
          progressStream,
          createWriteStream(archivePath, { flags: canResume ? 'a' : 'w' })
        )
      } catch (error) {
        if (this.abortController.signal.aborted) {
          this.emitProgress({ stage: 'paused', received, percent: Math.floor((received / this.kernel.size) * 100) })
          throw new Error('内核下载已暂停,下次可继续')
        }
        throw error
      }
    }

    const archiveSize = (await stat(archivePath)).size
    if (archiveSize !== this.kernel.size) {
      throw new Error(`内核文件大小异常:应为 ${this.kernel.size} 字节,实际为 ${archiveSize} 字节`)
    }

    this.emitProgress({ stage: 'verifying', received: archiveSize, percent: 100 })
    const digest = await sha256File(archivePath)
    if (digest !== this.kernel.sha256) {
      await rm(archivePath, { force: true })
      throw new Error('内核 SHA-256 校验失败,已删除损坏文件')
    }

    const staging = join(this.baseDir, `.install-${randomUUID()}`)
    const destination = this.versionDir()
    const backup = join(this.baseDir, `.backup-${randomUUID()}`)
    this.emitProgress({ stage: 'extracting', percent: 100 })
    await mkdir(staging, { recursive: true })

    try {
      await this.expandZip(archivePath, staging)
      const executable = await findChromeExecutable(staging)
      if (!executable) throw new Error('内核压缩包中没有找到 chrome.exe')

      const executableRelativePath = relative(staging, executable)
      await writeFile(
        join(staging, METADATA_FILE),
        JSON.stringify({ version: this.kernel.version, executable: executableRelativePath }, null, 2),
        'utf-8'
      )

      const hadPrevious = await pathExists(destination)
      if (hadPrevious) await rename(destination, backup)
      try {
        await rename(staging, destination)
      } catch (error) {
        if (hadPrevious) await rename(backup, destination).catch(() => {})
        throw error
      }
      if (hadPrevious) await rm(backup, { recursive: true, force: true })
      await rm(archivePath, { force: true })

      const installedPath = join(destination, executableRelativePath)
      this.emitProgress({ stage: 'ready', received: this.kernel.size, percent: 100 })
      return installedPath
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }
}
