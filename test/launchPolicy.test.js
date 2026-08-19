import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeStartupPolicy, runtimeWithSystemProxy } from '../src/main/launchPolicy.js'

test('startup policy normalizes unsupported values to safe prompts', () => {
  assert.deepEqual(normalizeStartupPolicy(), {
    ipChangeAction: 'ask',
    proxyFailureAction: 'ask'
  })
  assert.deepEqual(normalizeStartupPolicy({ ipChangeAction: 'auto', proxyFailureAction: 'system' }), {
    ipChangeAction: 'auto',
    proxyFailureAction: 'system'
  })
  assert.deepEqual(normalizeStartupPolicy({ ipChangeAction: 'ignore', proxyFailureAction: 'direct' }), {
    ipChangeAction: 'ask',
    proxyFailureAction: 'ask'
  })
})

test('system proxy fallback changes only the runtime copy', () => {
  const profile = { id: 'p1', proxy: { enabled: true, host: 'proxy.example', port: '8080' } }
  const runtime = runtimeWithSystemProxy(profile)
  assert.equal(runtime.proxy.enabled, false)
  assert.equal(runtime.proxy.host, 'proxy.example')
  assert.equal(profile.proxy.enabled, true)
})
