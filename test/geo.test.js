import assert from 'node:assert/strict'
import { test } from 'node:test'
import { GEO_PROVIDERS, parseProviderData } from '../src/main/geo.js'

test('GeoIP fallback list contains the verified free providers', () => {
  assert.deepEqual(
    GEO_PROVIDERS.map((provider) => provider.label),
    ['IPinfo', 'IP123.in / IP234.in', 'IPRust', 'IP-API', 'IP2Location']
  )
})

test('GeoIP provider payloads normalize to one shape', () => {
  assert.deepEqual(parseProviderData('iprust', {
    ip: '203.0.113.7',
    country_short: 'JP',
    country_long: 'Japan',
    timezone: 'Asia/Tokyo',
    latitude: '35.68',
    longitude: '139.69'
  }), {
    ip: '203.0.113.7',
    country: 'Japan',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    latitude: '35.68',
    longitude: '139.69'
  })

  assert.deepEqual(parseProviderData('ipinfo', {
    ip: '198.51.100.8',
    country: 'US',
    timezone: 'America/New_York',
    loc: '40.7,-74.0'
  }), {
    ip: '198.51.100.8',
    country: 'US',
    countryCode: 'US',
    timezone: 'America/New_York',
    latitude: 40.7,
    longitude: -74
  })
})
