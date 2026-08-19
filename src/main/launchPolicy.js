const IP_CHANGE_ACTIONS = new Set(['ask', 'block', 'auto'])
const PROXY_FAILURE_ACTIONS = new Set(['ask', 'block', 'system'])

export function normalizeStartupPolicy(value = {}) {
  return {
    ipChangeAction: IP_CHANGE_ACTIONS.has(value.ipChangeAction) ? value.ipChangeAction : 'ask',
    proxyFailureAction: PROXY_FAILURE_ACTIONS.has(value.proxyFailureAction) ? value.proxyFailureAction : 'ask'
  }
}

export function runtimeWithSystemProxy(profile) {
  return {
    ...profile,
    proxy: {
      ...(profile.proxy || {}),
      enabled: false
    }
  }
}
