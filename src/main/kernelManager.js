import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createReadStream, createWriteStream } from 'node:fs'
import { access, appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
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

function serializeError(error, depth = 0) {
  if (error == null || depth > 4) return undefined
  if (typeof error !== 'object') return { message: String(error) }

  const serialized = {
    name: error.name || error.constructor?.name || 'Error',
    message: error.message || String(error)
  }
  if (error.code) serialized.code = error.code
  if (error.errno) serialized.errno = error.errno
  if (error.syscall) serialized.syscall = error.syscall
  if (error.address) serialized.address = error.address
  if (error.port) serialized.port = error.port
  if (error.cause) serialized.cause = serializeError(error.cause, depth + 1)
  return serialized
}

function findErrorCode(error) {
  let current = error
  for (let depth = 0; current && depth <= 4; depth += 1) {
    if (current.code) return current.code
    current = current.cause
  }
  return ''
}

function presentInstallError(error, baseDir) {
  const code = findErrorCode(error)
  if (!['EACCES', 'EPERM'].includes(code)) return error
  return new Error(
    `无法写入内核目录 "${baseDir}" (${code}),请选择当前用户可写的目录后重试`,
    { cause: error }
  )
}

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
    '& { param($archive, $destination) Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory($archive, $destination) }'
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
    this.resolveProxy = options.resolveProxy || null
    this.networkLabel = options.networkLabel || 'Node fetch'
    this.expandZip = options.expandZip || expandZip
    this.platform = options.platform || process.platform
    this.customLogPath = options.logPath || ''
    this.installLogPath = this.customLogPath || join(baseDir, 'install.log')
    this.logWritePromise = Promise.resolve()
    this.installPromise = null
    this.abortController = null
    this.listeners = new Set()
    this.progress = { stage: 'idle', received: 0, total: this.kernel.size, percent: 0 }
  }

  setBaseDir(baseDir) {
    if (!baseDir || baseDir === this.baseDir) return
    if (this.installPromise) throw new Error('内核正在安装,暂时不能更改安装目录')
    this.baseDir = baseDir
    if (!this.customLogPath) this.installLogPath = join(baseDir, 'install.log')
    this.progress = { stage: 'idle', received: 0, total: this.kernel.size, percent: 0 }
  }

  writeLog(level, message, details) {
    const suffix = details ? ` ${JSON.stringify(details)}` : ''
    const line = `[${new Date().toISOString()}] [${level}] ${message}${suffix}\n`
    this.logWritePromise = this.logWritePromise
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.installLogPath), { recursive: true })
        await appendFile(this.installLogPath, line, 'utf-8')
      })
    // 日志写入失败不应中断内核安装。
    return this.logWritePromise.catch(() => {})
  }

  async ensureLogFile() {
    await this.logWritePromise.catch(() => {})
    await mkdir(dirname(this.installLogPath), { recursive: true })
    await appendFile(this.installLogPath, '', 'utf-8')
    return this.installLogPath
  }

  async getLog() {
    const path = await this.ensureLogFile()
    return { path, text: await readFile(path, 'utf-8') }
  }

  async clearLog() {
    this.logWritePromise = this.logWritePromise
      .catch(() => {})
      .then(async () => {
        await mkdir(dirname(this.installLogPath), { recursive: true })
        await writeFile(this.installLogPath, '', 'utf-8')
      })
    await this.logWritePromise
    return this.getLog()
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
      .catch(async (error) => {
        const reportedError = this.progress.stage === 'paused' ? error : presentInstallError(error, this.baseDir)
        await this.writeLog(this.progress.stage === 'paused' ? 'WARN' : 'ERROR', '安装结束', {
          stage: this.progress.stage,
          error: serializeError(reportedError)
        })
        if (this.progress.stage !== 'paused') {
          this.emitProgress({ stage: 'error', message: reportedError.message || String(reportedError) })
        }
        throw reportedError
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
    const attempt = randomUUID().slice(0, 8)
    await this.writeLog('INFO', '开始安装内核', {
      attempt,
      version: this.kernel.version,
      platform: this.platform,
      network: this.networkLabel,
      downloadUrl: this.kernel.downloadUrl
    })

    const existing = await this.managedExecutable()
    if (existing) {
      await this.writeLog('INFO', '检测到已安装内核', { attempt, executable: existing })
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

    if (received > 0) {
      await this.writeLog('INFO', '检测到未完成下载', { attempt, received, expected: this.kernel.size })
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

      let proxy = '未提供代理解析器'
      if (this.resolveProxy) {
        try {
          proxy = await this.resolveProxy(this.kernel.downloadUrl)
        } catch (error) {
          proxy = '代理解析失败'
          await this.writeLog('WARN', '系统代理解析失败', { attempt, error: serializeError(error) })
        }
      }
      await this.writeLog('INFO', '开始下载', {
        attempt,
        received,
        resume: received > 0,
        proxy
      })

      let response
      try {
        response = await this.fetch(this.kernel.downloadUrl, {
          headers,
          redirect: 'follow',
          signal: this.abortController.signal
        })
      } catch (error) {
        if (this.abortController.signal.aborted) {
          this.emitProgress({
            stage: 'paused',
            received,
            percent: Math.floor((received / this.kernel.size) * 100)
          })
          throw new Error('内核下载已暂停,下次可继续', { cause: error })
        }

        const errorCode = findErrorCode(error)
        const codeHint = errorCode ? ` (${errorCode})` : ''
        throw new Error(
          `无法连接内核下载服务器${codeHint},请检查系统代理、防火墙或网络连接;详细原因请查看安装日志`,
          { cause: error }
        )
      }

      await this.writeLog('INFO', '收到下载响应', {
        attempt,
        status: response.status,
        contentLength: response.headers.get('content-length'),
        acceptRanges: response.headers.get('accept-ranges')
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
        await this.writeLog('INFO', '下载完成', { attempt, received })
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

    await this.writeLog('INFO', '开始校验文件', { attempt, archiveSize, algorithm: 'SHA-256' })
    this.emitProgress({ stage: 'verifying', received: archiveSize, percent: 100 })
    const digest = await sha256File(archivePath)
    if (digest !== this.kernel.sha256) {
      await rm(archivePath, { force: true })
      throw new Error('内核 SHA-256 校验失败,已删除损坏文件')
    }
    await this.writeLog('INFO', '文件校验通过', { attempt, sha256: digest })

    const staging = join(this.baseDir, `.install-${randomUUID()}`)
    const destination = this.versionDir()
    const backup = join(this.baseDir, `.backup-${randomUUID()}`)
    this.emitProgress({ stage: 'extracting', percent: 100 })
    await this.writeLog('INFO', '开始解压内核', { attempt, destination })
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
      await this.writeLog('INFO', '内核安装完成', { attempt, executable: installedPath })
      return installedPath
    } catch (error) {
      await rm(staging, { recursive: true, force: true })
      throw error
    }
  }
}
