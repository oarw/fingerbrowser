import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  assessLaunchMemory,
  MEMORY_PER_PROFILE,
  MIN_SYSTEM_RESERVE
} from '../src/main/memoryGuard.js'

test('memory guard reserves system memory and a budget per new profile', () => {
  const total = 8 * 1024 ** 3
  const sufficient = assessLaunchMemory(MIN_SYSTEM_RESERVE + MEMORY_PER_PROFILE * 2, total, 2)
  assert.equal(sufficient.ok, true)
  assert.equal(sufficient.browserBudgetBytes, MEMORY_PER_PROFILE * 2)

  const insufficient = assessLaunchMemory(MIN_SYSTEM_RESERVE + MEMORY_PER_PROFILE - 1, total, 2)
  assert.equal(insufficient.ok, false)
  assert.ok(insufficient.shortfallBytes > 0)
})

test('memory guard allows an empty launch set', () => {
  assert.equal(assessLaunchMemory(0, 0, 0).ok, true)
})
