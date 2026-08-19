import { pathToFileURL } from 'node:url'

export function nextPrereleaseVersion(packageVersion, tags = []) {
  const match = String(packageVersion || '').trim().match(/^(\d+\.\d+\.\d+)(?:-pre\.\d+)?$/)
  if (!match) throw new Error(`Unsupported package version: ${packageVersion}`)

  const baseVersion = match[1]
  const prefix = `v${baseVersion}-pre.`
  let highest = 0

  for (const value of tags) {
    const tag = String(value || '').trim()
    if (!tag.startsWith(prefix)) continue
    const sequence = tag.slice(prefix.length)
    if (!/^\d+$/.test(sequence)) continue
    highest = Math.max(highest, Number(sequence))
  }

  return `${baseVersion}-pre.${highest + 1}`
}

async function main() {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const tags = input.split(/\r?\n/).filter(Boolean)
  process.stdout.write(nextPrereleaseVersion(process.argv[2], tags))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
