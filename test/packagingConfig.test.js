import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

test('release assets use stable filenames without spaces', async () => {
  const config = await readFile(new URL('../electron-builder.yml', import.meta.url), 'utf8')
  assert.match(config, /^artifactName: \$\{productName\}-\$\{version\}-\$\{os\}-\$\{arch\}\.\$\{ext\}$/m)
})
