import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildUpstreamUrl,
  needsBridge,
  parseSystemProxyResult
} from '../src/main/proxyBridge.js'

test('parseSystemProxyResult selects the first usable Windows proxy directive', () => {
  assert.equal(parseSystemProxyResult('PROXY 127.0.0.1:10808; DIRECT'), 'http://127.0.0.1:10808')
  assert.equal(parseSystemProxyResult('SOCKS5 127.0.0.1:10809; DIRECT'), 'socks5://127.0.0.1:10809')
  assert.equal(parseSystemProxyResult('DIRECT'), '')
})

test('buildUpstreamUrl preserves proxy protocol and safely encodes credentials', () => {
  assert.equal(
    buildUpstreamUrl({
      type: 'https',
      host: 'proxy.example',
      port: '443',
      username: 'user@name',
      password: 'p:a ss'
    }),
    'https://user%40name:p%3Aa%20ss@proxy.example:443'
  )
})

test('system chaining and TLS policy require a local bridge', () => {
  const base = { enabled: true, type: 'http', host: 'proxy.example', port: '8080' }
  assert.equal(needsBridge({ ...base, useSystemProxy: false }), false)
  assert.equal(needsBridge({ ...base, useSystemProxy: true }), true)
  assert.equal(needsBridge({ ...base, useSystemProxy: false, ignoreTlsErrors: true }), true)
})
