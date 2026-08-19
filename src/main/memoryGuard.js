const MIB = 1024 * 1024
const GIB = 1024 * MIB

export const MEMORY_PER_PROFILE = 768 * MIB
export const MIN_SYSTEM_RESERVE = 1536 * MIB

export function assessLaunchMemory(availableBytes, totalBytes, launchCount) {
  const count = Math.max(0, Number(launchCount) || 0)
  const available = Math.max(0, Number(availableBytes) || 0)
  const total = Math.max(0, Number(totalBytes) || 0)
  const reserve = Math.max(MIN_SYSTEM_RESERVE, Math.round(total * 0.12))
  const browserBudget = count * MEMORY_PER_PROFILE
  const required = reserve + browserBudget
  return {
    ok: count === 0 || available >= required,
    count,
    availableBytes: available,
    reserveBytes: reserve,
    browserBudgetBytes: browserBudget,
    requiredBytes: required,
    shortfallBytes: Math.max(0, required - available)
  }
}

export function formatMemory(bytes) {
  return `${(Math.max(0, Number(bytes) || 0) / GIB).toFixed(1)} GB`
}
