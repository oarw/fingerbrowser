import { access, cp, mkdir, rename, rm } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'

async function pathExists(path) {
  if (!path) return false
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function remapKernelPath(kernelPath, fromDirectory, toDirectory) {
  if (!kernelPath) return kernelPath
  const source = resolve(fromDirectory)
  const candidate = resolve(kernelPath)
  const prefix = `${source}${sep}`
  if (!candidate.toLowerCase().startsWith(prefix.toLowerCase())) return kernelPath
  return join(toDirectory, relative(source, candidate))
}

export async function migrateLegacyKernelDirectory(settings, legacyDirectory, durableDirectory) {
  const rawDirectory = typeof settings.kernelDirectory === 'string' ? settings.kernelDirectory.trim() : ''
  const legacy = resolve(legacyDirectory)
  const durable = resolve(durableDirectory)
  const configured = rawDirectory ? resolve(rawDirectory) : ''
  const usesLegacyDefault = !configured || configured.toLowerCase() === legacy.toLowerCase()
  if (!usesLegacyDefault || legacy.toLowerCase() === durable.toLowerCase()) return settings

  const remappedPath = remapKernelPath(settings.kernelPath, legacy, durable)
  if (!(await pathExists(legacy))) {
    return { ...settings, kernelDirectory: durable, kernelPath: remappedPath }
  }

  let migrated = false
  if (!(await pathExists(durable))) {
    try {
      await rename(legacy, durable)
      migrated = true
    } catch {
      // 安装目录和持久目录可能位于不同磁盘,下方改用复制。
    }
  }
  if (!migrated) {
    try {
      await mkdir(durable, { recursive: true })
      await cp(legacy, durable, { recursive: true, force: false })
      await rm(legacy, { recursive: true, force: true })
      migrated = true
    } catch {
      // 迁移失败时保留旧目录,让用户仍可在设置中手动选择它。
    }
  }

  const remappedPathReady = remappedPath !== settings.kernelPath && await pathExists(remappedPath)
  if (!migrated && !remappedPathReady) return settings
  return { ...settings, kernelDirectory: durable, kernelPath: remappedPath }
}
