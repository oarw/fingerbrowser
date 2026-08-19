import { pathToFileURL } from 'node:url'

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:-pre\.(\d+))?$/

export function nextReleaseVersion(packageVersion, tags = []) {
  const value = String(packageVersion || '').trim()
  const match = value.match(VERSION_PATTERN)
  if (!match) throw new Error(`Unsupported package version: ${packageVersion}`)

  const [, major, minor, patch, prereleaseSequence] = match
  const baseVersion = `${major}.${minor}.${patch}`
  const tagValues = new Set(tags.map((tag) => String(tag || '').trim()).filter(Boolean))

  if (prereleaseSequence !== undefined) {
    const prefix = `v${baseVersion}-pre.`
    let highest = 0
    for (const tag of tagValues) {
      if (!tag.startsWith(prefix)) continue
      const sequence = tag.slice(prefix.length)
      if (/^\d+$/.test(sequence)) highest = Math.max(highest, Number(sequence))
    }
    return `${baseVersion}-pre.${highest + 1}`
  }

  let nextPatch = Number(patch)
  while (tagValues.has(`v${major}.${minor}.${nextPatch}`)) nextPatch += 1
  return `${major}.${minor}.${nextPatch}`
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const tags = input.split(/\r?\n/).filter(Boolean)
  process.stdout.write(nextReleaseVersion(process.argv[2], tags))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
