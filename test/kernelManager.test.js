import assert from 'node:assert/strict'
import { access, mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, before, test } from 'node:test'
import { createHash, randomUUID } from 'node:crypto'
import { Response } from 'undici'
import { findChromeExecutable, KernelManager, MANAGED_KERNEL, sha256File } from '../src/main/kernelManager.js'

const root = join(tmpdir(), `fingerbrowser-kernel-test-${randomUUID()}`)

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
})
