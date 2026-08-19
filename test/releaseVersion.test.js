import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextReleaseVersion } from '../scripts/next-release.mjs'
import { nextPrereleaseVersion } from '../scripts/next-prerelease.mjs'

test('nextPrereleaseVersion increments the highest matching prerelease tag', () => {
  assert.equal(
    nextPrereleaseVersion('0.2.1-pre.5', [
      'v0.2.1-pre.2',
      'v0.2.0',
      'v0.2.1-pre.invalid',
      'v0.2.1-pre.5',
      'v0.2.1-pre.4',
      'v1.0.0-pre.99'
    ]),
    '0.2.1-pre.6'
  )
})

test('nextPrereleaseVersion starts a new release series at one', () => {
  assert.equal(nextPrereleaseVersion('0.3.0', ['v0.2.1-pre.12']), '0.3.0-pre.1')
})

test('nextPrereleaseVersion rejects unsupported package versions', () => {
  assert.throws(() => nextPrereleaseVersion('0.2.1-beta.1'), /Unsupported package version/)
})

test('nextReleaseVersion increments stable patch versions past existing tags', () => {
  assert.equal(
    nextReleaseVersion('0.2.1', ['v0.2.0', 'v0.2.1', 'v0.2.2', 'v0.2.2-pre.1']),
    '0.2.3'
  )
})

test('nextReleaseVersion keeps an unused manually selected stable version', () => {
  assert.equal(nextReleaseVersion('1.0.0', ['v0.2.1', 'v0.2.1-pre.6']), '1.0.0')
})

test('nextReleaseVersion increments matching prereleases', () => {
  assert.equal(nextReleaseVersion('0.2.1-pre.5', ['v0.2.1-pre.2', 'v0.2.1-pre.5']), '0.2.1-pre.6')
})
