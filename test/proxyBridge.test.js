import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildUpstreamUrl,
  createHttpsTunnelOptions,
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

test('HTTPS system chaining connects to the local tunnel with the real proxy TLS identity', () => {
  const ipProxy = { type: 'https', host: '130.253.2.250', port: '443' }
  const ipTunnel = createHttpsTunnelOptions(ipProxy, '6463')
  const domainTunnel = createHttpsTunnelOptions({ ...ipProxy, host: 'proxy.example' }, '6464')

  try {
    assert.equal(ipTunnel.upstreamProxyUrl, 'https://127.0.0.1:6463')
    assert.equal(domainTunnel.upstreamProxyUrl, 'https://127.0.0.1:6464')
    assert.equal(ipTunnel.httpsAgent.options.servername, '')
    assert.equal(domainTunnel.httpsAgent.options.servername, 'proxy.example')
    assert.equal(ipTunnel.httpsAgent.options.rejectUnauthorized, true)
    assert.equal(
      ipTunnel.httpsAgent.options.checkServerIdentity('127.0.0.1', {
        subjectaltname: 'IP Address:130.253.2.250'
      }),
      undefined
    )
  } finally {
    ipTunnel.httpsAgent.destroy()
    domainTunnel.httpsAgent.destroy()
  }
})
