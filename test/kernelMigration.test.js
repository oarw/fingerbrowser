import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { migrateLegacyKernelDirectory } from '../src/main/kernelMigration.js'

test('legacy managed kernel moves outside the replaceable install directory', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'fingerbrowser-kernel-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'FingerBrowser', 'kernels')
  const durable = join(root, 'FingerBrowserData', 'kernels')
  const executable = join(legacy, '148.0.7778.215', 'chrome.exe')
  await mkdir(join(legacy, '148.0.7778.215'), { recursive: true })
  await writeFile(executable, 'kernel')

  const next = await migrateLegacyKernelDirectory({
    kernelDirectory: legacy,
    kernelPath: executable
  }, legacy, durable)

  assert.equal(next.kernelDirectory, durable)
  assert.equal(next.kernelPath, join(durable, '148.0.7778.215', 'chrome.exe'))
  assert.equal(await readFile(next.kernelPath, 'utf-8'), 'kernel')
})

test('custom kernel directory is not migrated', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'fingerbrowser-custom-kernel-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'FingerBrowser', 'kernels')
  const custom = join(root, 'CustomKernels')
  await mkdir(legacy, { recursive: true })

  const settings = { kernelDirectory: custom, kernelPath: join(custom, 'chrome.exe') }
  assert.equal(
    await migrateLegacyKernelDirectory(settings, legacy, join(root, 'FingerBrowserData', 'kernels')),
    settings
  )
})

test('settings follow a kernel already moved by the installer hook', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'fingerbrowser-pre-moved-kernel-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const legacy = join(root, 'FingerBrowser', 'kernels')
  const durable = join(root, 'FingerBrowserData', 'kernels')
  const oldExecutable = join(legacy, '148.0.7778.215', 'chrome.exe')
  const newExecutable = join(durable, '148.0.7778.215', 'chrome.exe')
  await mkdir(join(durable, '148.0.7778.215'), { recursive: true })
  await writeFile(newExecutable, 'kernel')

  const next = await migrateLegacyKernelDirectory({
    kernelDirectory: legacy,
    kernelPath: oldExecutable
  }, legacy, durable)

  assert.equal(next.kernelDirectory, durable)
  assert.equal(next.kernelPath, newExecutable)
})
