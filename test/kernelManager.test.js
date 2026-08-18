import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, before, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { Response } from 'undici'
import { expandZip, findChromeExecutable, KernelManager, MANAGED_KERNEL, sha256File } from '../src/main/kernelManager.js'

const root = join(tmpdir(), `fingerbrowser-kernel-test-${randomUUID()}`)
const execFileAsync = promisify(execFile)

before(() => mkdir(root, { recursive: true }))
after(() => rm(root, { recursive: true, force: true }))

test('managed kernel manifest pins the official Windows archive', () => {
  assert.equal(MANAGED_KERNEL.version, '148.0.7778.215')
  assert.equal(MANAGED_KERNEL.size, 189767686)
  assert.match(MANAGED_KERNEL.downloadUrl, /^https:\/\/github\.com\/adryfish\/fingerprint-chromium\/releases\/download\//)
  assert.match(MANAGED_KERNEL.sha256, /^[a-f0-9]{64}$/)
})

test('sha256File hashes content without loading it into memory', async () => {
  const file = join(root, 'hash.txt')
  await writeFile(file, 'FingerBrowser\n', 'utf-8')
  assert.equal(await sha256File(file), 'f51a1a6a12f45e87bd541bd3c9d111cb7f22a3ca16decd27e606b2790271281e')
})

test('findChromeExecutable locates chrome.exe below an archive root', async () => {
  const archiveRoot = join(root, 'archive')
  const chromeDir = join(archiveRoot, 'ungoogled-chromium')
  await mkdir(chromeDir, { recursive: true })
  await writeFile(join(chromeDir, 'chrome.exe'), '')
  assert.equal(await findChromeExecutable(archiveRoot), join(chromeDir, 'chrome.exe'))
})

test('expandZip extracts a valid archive with a .zip.part extension', { skip: process.platform !== 'win32' }, async () => {
  const fixtureRoot = join(root, 'zip-part-fixture')
  const source = join(fixtureRoot, 'source', 'chromium')
  const zipPath = join(fixtureRoot, 'kernel.zip')
  const partPath = `${zipPath}.part`
  const destination = join(fixtureRoot, 'extracted')
  await mkdir(source, { recursive: true })
  await writeFile(join(source, 'chrome.exe'), 'test executable')

  const script =
    '& { param($source, $archive) Compress-Archive -Path (Join-Path $source "*") -DestinationPath $archive -Force }'
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script, dirname(source), zipPath])
  await rename(zipPath, partPath)
  await mkdir(destination, { recursive: true })

  await expandZip(partPath, destination)
  await access(join(destination, 'chromium', 'chrome.exe'))
})

test('KernelManager resumes, verifies, installs, and activates a managed kernel', async () => {
  const baseDir = join(root, 'manager')
  const archive = Buffer.from('small deterministic archive payload')
  const splitAt = 11
  const kernel = {
    version: 'test-1',
    label: 'Test Chromium',
    archiveName: 'test-kernel.zip',
    downloadUrl: 'https://example.test/test-kernel.zip',
    size: archive.length,
    sha256: createHash('sha256').update(archive).digest('hex'),
    sourceUrl: 'https://example.test/source'
  }
  let requestedRange = ''

  const manager = new KernelManager(baseDir, {
    platform: 'win32',
    kernel,
    fetch: async (_url, options) => {
      requestedRange = options.headers.Range
      return new Response(archive.subarray(splitAt), { status: 206 })
    },
    expandZip: async (_archivePath, destination) => {
      const chromeDir = join(destination, 'chromium')
      await mkdir(chromeDir, { recursive: true })
      await writeFile(join(chromeDir, 'chrome.exe'), 'test executable')
    }
  })

  await mkdir(dirname(manager.archivePath()), { recursive: true })
  await writeFile(manager.archivePath(), archive.subarray(0, splitAt))

  const executable = await manager.install()
  await access(executable)
  assert.equal(requestedRange, `bytes=${splitAt}-`)
  assert.equal(manager.progress.stage, 'ready')

  const status = await manager.getStatus(executable)
  assert.equal(status.ready, true)
  assert.equal(status.source, 'managed')
  assert.equal(status.managed.version, kernel.version)
  assert.equal(status.managed.path, executable)

  const log = await manager.getLog()
  assert.match(log.text, /开始安装内核/)
  assert.match(log.text, /内核安装完成/)
})

test('KernelManager preserves network error causes in the install log', async () => {
  const baseDir = join(root, 'network-error')
  const connectionError = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:10808'), {
    code: 'ECONNREFUSED',
    address: '127.0.0.1',
    port: 10808
  })
  const fetchError = new TypeError('fetch failed')
  fetchError.cause = connectionError

  const manager = new KernelManager(baseDir, {
    platform: 'win32',
    kernel: {
      version: 'test-network-error',
      label: 'Test Chromium',
      archiveName: 'test-network-error.zip',
      downloadUrl: 'https://example.test/test-network-error.zip',
      size: 1,
      sha256: '0'.repeat(64),
      sourceUrl: 'https://example.test/source'
    },
    networkLabel: 'test network stack',
    resolveProxy: async () => 'PROXY 127.0.0.1:10808',
    fetch: async () => {
      throw fetchError
    }
  })

  await assert.rejects(manager.install(), /ECONNREFUSED/)
  assert.equal(manager.progress.stage, 'error')

  const log = await manager.getLog()
  assert.match(log.text, /PROXY 127\.0\.0\.1:10808/)
  assert.match(log.text, /ECONNREFUSED/)
  assert.match(log.text, /connect ECONNREFUSED 127\.0\.0\.1:10808/)

  const cleared = await manager.clearLog()
  assert.equal(cleared.text, '')
})

test('KernelManager switches all managed paths with its base directory', async () => {
  const initialDirectory = join(root, 'switch-initial')
  const nextDirectory = join(root, 'switch-next')
  const manager = new KernelManager(initialDirectory, {
    platform: 'win32',
    kernel: {
      ...MANAGED_KERNEL,
      version: 'test-directory-switch',
      archiveName: 'test-directory-switch.zip'
    }
  })

  manager.setBaseDir(nextDirectory)

  assert.equal(manager.baseDir, nextDirectory)
  assert.equal(manager.versionDir(), join(nextDirectory, 'test-directory-switch'))
  assert.equal(manager.archivePath(), join(nextDirectory, 'downloads', 'test-directory-switch.zip.part'))
  assert.equal((await manager.getLog()).path, join(nextDirectory, 'install.log'))
  assert.equal(manager.progress.stage, 'idle')
})
