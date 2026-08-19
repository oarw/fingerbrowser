import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localeForCountry } from '../src/main/locale.js'
import {
  applyGeoToProfile,
  geoConfirmation,
  PROFILE_MANIFEST_VERSION,
  proxyIdentity,
  validateProfileConsistency,
  withProfileManifest
} from '../src/main/profileManifest.js'

function profile(overrides = {}) {
  return {
    id: 'profile-1',
    name: 'US profile',
    fingerprint: {
      seed: 123456,
      platform: 'windows',
      platformVersion: '10.0.0',
      brand: 'Chrome',
      brandVersion: '',
      hardwareConcurrency: 8,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/New_York',
      webrtcMode: 'disable_non_proxied_udp'
    },
    proxy: {
      enabled: true,
      type: 'http',
      host: 'proxy.example',
      port: '8080',
      username: 'private-user',
      password: 'private-password',
      useSystemProxy: true,
      ignoreTlsErrors: false
    },
    ...overrides
  }
}

function geo(overrides = {}) {
  return {
    ip: '203.0.113.10',
    country: 'United States',
    countryCode: 'US',
    timezone: 'America/New_York',
    latitude: 40.7,
    longitude: -74,
    language: 'en-US',
    acceptLanguages: 'en-US,en',
    source: 'test',
    proxyIdentity: 'http://proxy.example:8080',
    systemProxy: true,
    checkedAt: '2026-08-18T00:00:00.000Z',
    ...overrides
  }
}

test('localeForCountry returns deterministic regional language defaults', () => {
  assert.deepEqual(localeForCountry('JP'), { language: 'ja-JP', acceptLanguages: 'ja-JP,ja' })
  assert.deepEqual(localeForCountry('ca'), { language: 'en-CA', acceptLanguages: 'en-CA,en,fr-CA,fr' })
  assert.deepEqual(localeForCountry('unknown'), { language: 'en-US', acceptLanguages: 'en-US,en' })
})

test('profile manifest is versioned and excludes proxy credentials', () => {
  const manifested = withProfileManifest(profile(), {
    geo: geo(),
    now: '2026-08-18T01:00:00.000Z'
  })
  assert.equal(manifested.manifest.schemaVersion, PROFILE_MANIFEST_VERSION)
  assert.equal(manifested.manifest.revision, 1)
  assert.equal(manifested.manifest.consistency.status, 'ready')
  assert.equal(manifested.manifest.network.proxyIdentity, 'http://proxy.example:8080')
  assert.doesNotMatch(JSON.stringify(manifested.manifest), /private-user|private-password/)
})

test('manifest revision changes only when the identity snapshot changes', () => {
  const first = withProfileManifest(profile(), { geo: geo(), now: '2026-08-18T01:00:00.000Z' })
  const unchanged = withProfileManifest(first, { now: '2026-08-18T02:00:00.000Z' })
  const changed = withProfileManifest(
    { ...unchanged, fingerprint: { ...unchanged.fingerprint, hardwareConcurrency: 12 } },
    { now: '2026-08-18T03:00:00.000Z' }
  )
  assert.equal(unchanged.manifest.revision, 1)
  assert.equal(unchanged.manifest.updatedAt, first.manifest.updatedAt)
  assert.equal(changed.manifest.revision, 2)
  assert.equal(changed.manifest.updatedAt, '2026-08-18T03:00:00.000Z')
})

test('consistency validation reports blocking errors and GeoIP mismatches', () => {
  const invalid = profile({
    fingerprint: {
      ...profile().fingerprint,
      seed: 'invalid',
      timezone: 'Mars/Olympus',
      language: 'de-DE',
      acceptLanguages: 'fr-FR,fr',
      webrtcMode: 'off'
    }
  })
  const result = validateProfileConsistency(invalid, geo())
  assert.equal(result.status, 'error')
  assert.ok(result.issues.some((issue) => issue.code === 'FINGERPRINT_SEED_INVALID'))
  assert.ok(result.issues.some((issue) => issue.code === 'TIMEZONE_INVALID'))
  assert.ok(result.issues.some((issue) => issue.code === 'GEO_TIMEZONE_MISMATCH'))
  assert.ok(result.issues.some((issue) => issue.code === 'GEO_LANGUAGE_MISMATCH'))
  assert.ok(result.issues.some((issue) => issue.code === 'WEBRTC_LEAK_RISK'))
})

test('GeoIP application updates regional fields and requires confirmation on IP changes', () => {
  const current = withProfileManifest(profile(), { geo: geo(), now: '2026-08-18T01:00:00.000Z' })
  const nextGeo = geo({
    ip: '198.51.100.22',
    country: 'Japan',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    language: 'ja-JP',
    acceptLanguages: 'ja-JP,ja'
  })
  const confirmation = geoConfirmation(current, nextGeo)
  assert.equal(confirmation.required, true)
  assert.ok(confirmation.reasons.some((reason) => reason.includes('198.51.100.22')))

  const applied = applyGeoToProfile(current, nextGeo, '2026-08-18T04:00:00.000Z')
  assert.equal(applied.fingerprint.timezone, 'Asia/Tokyo')
  assert.equal(applied.fingerprint.language, 'ja-JP')
  assert.equal(applied.manifest.geo.countryCode, 'JP')
  assert.equal(applied.manifest.revision, 2)
  assert.equal(applied.manifest.consistency.status, 'ready')
})

test('proxyIdentity is stable and never contains credentials', () => {
  assert.equal(proxyIdentity(profile().proxy), 'http://proxy.example:8080')
  assert.equal(proxyIdentity({ ...profile().proxy, type: 'https' }), 'https://proxy.example:8080')
  assert.equal(proxyIdentity({ enabled: false }), 'direct')
})

test('disabled TLS verification is persisted as a non-blocking security warning', () => {
  const result = withProfileManifest({
    ...profile(),
    proxy: { ...profile().proxy, ignoreTlsErrors: true }
  }, { geo: geo() })
  assert.equal(result.manifest.network.ignoreTlsErrors, true)
  assert.equal(result.manifest.consistency.status, 'warning')
  assert.ok(result.manifest.consistency.issues.some((issue) => issue.code === 'TLS_VERIFICATION_DISABLED'))
})

test('proxy health is tied to the tested endpoint and resets after endpoint changes', () => {
  const healthy = withProfileManifest(profile(), {
    geo: geo(),
    proxyHealth: {
      status: 'available',
      proxyIdentity: 'http://proxy.example:8080',
      checkedAt: '2026-08-18T01:00:00.000Z'
    }
  })
  assert.equal(healthy.manifest.proxyHealth.status, 'available')
  assert.equal(healthy.manifest.proxyHealth.proxyIdentity, 'http://proxy.example:8080')

  const changed = withProfileManifest({
    ...healthy,
    proxy: { ...healthy.proxy, host: 'dead.example' }
  }, { previousManifest: healthy.manifest })
  assert.equal(changed.manifest.proxyHealth.status, 'unknown')
  assert.equal(changed.manifest.geo, null)
})
