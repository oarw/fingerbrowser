<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { AlertTriangle, CheckCircle2, RefreshCw, Save, X } from 'lucide-vue-next'

const props = defineProps({
  profile: { type: Object, required: true },
  autoTest: { type: Boolean, default: false }
})
const emit = defineEmits(['close', 'saved'])

const source = props.profile.proxy || {}
const form = reactive({
  enabled: Boolean(source.enabled),
  type: ['http', 'https', 'socks5'].includes(source.type) ? source.type : 'http',
  host: source.host || '',
  port: String(source.port || ''),
  username: source.username || '',
  password: source.password || '',
  useSystemProxy: source.useSystemProxy !== false,
  ignoreTlsErrors: Boolean(source.ignoreTlsErrors)
})
const testing = ref(false)
const saving = ref(false)
const feedback = reactive({ status: '', title: '', detail: '' })
const testedGeo = ref(null)
const testedKey = ref('')
const dialogElement = ref(null)

const proxyKey = computed(() => [
  form.enabled,
  form.type,
  form.host.trim().toLowerCase(),
  form.port.trim(),
  form.username.trim(),
  form.password,
  form.useSystemProxy,
  form.ignoreTlsErrors
].join('\u0000'))

watch(proxyKey, (next) => {
  if (testedKey.value && testedKey.value !== next) {
    testedGeo.value = null
    feedback.status = ''
    feedback.title = ''
    feedback.detail = ''
  }
})

onMounted(() => {
  window.addEventListener('keydown', onDialogKeydown)
  void nextTick(() => {
    const selector = form.enabled ? '#quick-proxy-host' : 'input[type="checkbox"]'
    dialogElement.value?.querySelector(selector)?.focus()
  })
  if (props.autoTest) void testProxy()
})

onBeforeUnmount(() => window.removeEventListener('keydown', onDialogKeydown))

function requestClose() {
  if (!testing.value && !saving.value) emit('close')
}

function onDialogKeydown(event) {
  if (event.key === 'Escape') {
    event.preventDefault()
    requestClose()
    return
  }
  if (event.key !== 'Tab' || !dialogElement.value) return

  const focusable = [...dialogElement.value.querySelectorAll(
    'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
  )]
  if (!focusable.length) return
  const first = focusable[0]
  const last = focusable.at(-1)
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function normalizedProxy() {
  return {
    enabled: form.enabled,
    type: form.type,
    host: form.host.trim(),
    port: form.port.trim(),
    username: form.username.trim(),
    password: form.password,
    useSystemProxy: form.useSystemProxy,
    ignoreTlsErrors: form.ignoreTlsErrors
  }
}

function validateProxy({ requireEnabled = false } = {}) {
  if (requireEnabled && !form.enabled) return '请先启用代理'
  if (form.enabled && (!form.host.trim() || !form.port.trim())) return '启用代理后必须填写主机和端口'
  return ''
}

async function testProxy() {
  const validation = validateProxy({ requireEnabled: true })
  if (validation) {
    Object.assign(feedback, { status: 'error', title: '无法测试代理', detail: validation })
    return
  }

  testing.value = true
  Object.assign(feedback, { status: 'checking', title: '正在检测代理出口', detail: '正在验证连接并查询出口 IP...' })
  try {
    const geo = await window.api.detectGeo(normalizedProxy())
    testedGeo.value = geo
    testedKey.value = proxyKey.value
    const location = [geo.country || geo.countryCode, geo.timezone].filter(Boolean).join(' · ')
    const route = geo.systemProxy ? '系统代理 → 指定代理' : '指定代理直连'
    Object.assign(feedback, {
      status: 'success',
      title: `代理可用 · ${geo.ip}`,
      detail: [location, geo.source, route].filter(Boolean).join(' · ')
    })
  } catch (error) {
    testedGeo.value = null
    testedKey.value = ''
    Object.assign(feedback, {
      status: 'error',
      title: '代理测试失败',
      detail: error.message || String(error)
    })
  } finally {
    testing.value = false
  }
}

async function save() {
  const validation = validateProxy()
  if (validation) {
    Object.assign(feedback, { status: 'error', title: '无法保存代理', detail: validation })
    return
  }

  saving.value = true
  try {
    const next = { ...props.profile, proxy: normalizedProxy() }
    if (testedGeo.value && testedKey.value === proxyKey.value) {
      next.manifest = { ...(props.profile.manifest || {}), geo: testedGeo.value }
    }
    const saved = await window.api.saveProfile(next)
    emit('saved', saved)
  } catch (error) {
    Object.assign(feedback, {
      status: 'error',
      title: '代理保存失败',
      detail: error.message || String(error)
    })
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="requestClose">
    <form
      ref="dialogElement"
      class="dialog quick-proxy-dialog"
      data-smoke="quick-proxy-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="quick-proxy-title"
      :aria-busy="testing || saving"
      @submit.prevent="save"
    >
      <header class="quick-proxy-header">
        <div>
          <p class="eyebrow">{{ profile.name }}</p>
          <h2 id="quick-proxy-title">快速代理设置</h2>
        </div>
        <button class="icon-button compact" data-smoke="quick-proxy-close" type="button" title="关闭" aria-label="关闭" :disabled="testing || saving" @click="requestClose">
          <X :size="17" />
        </button>
      </header>

      <div class="dialog-body quick-proxy-body">
        <label class="toggle-control quick-proxy-enabled">
          <input v-model="form.enabled" type="checkbox" />
          <span aria-hidden="true"></span>
          <span class="toggle-copy"><strong>启用代理</strong><small>关闭后此环境直接使用本机网络。</small></span>
        </label>

        <fieldset :disabled="!form.enabled || testing || saving">
          <legend>代理端点</legend>
          <div class="quick-proxy-endpoint">
            <div>
              <label for="quick-proxy-type">协议</label>
              <select id="quick-proxy-type" v-model="form.type">
                <option value="http">HTTP</option>
                <option value="https">HTTPS</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div>
              <label for="quick-proxy-host">主机</label>
              <input id="quick-proxy-host" v-model="form.host" placeholder="127.0.0.1" />
            </div>
            <div>
              <label for="quick-proxy-port">端口</label>
              <input id="quick-proxy-port" v-model="form.port" inputmode="numeric" placeholder="7890" />
            </div>
          </div>

          <div class="quick-proxy-credentials">
            <div><label for="quick-proxy-user">用户名</label><input id="quick-proxy-user" v-model="form.username" autocomplete="off" placeholder="可选" /></div>
            <div><label for="quick-proxy-password">密码</label><input id="quick-proxy-password" v-model="form.password" type="password" autocomplete="new-password" placeholder="可选" /></div>
          </div>

          <div class="quick-proxy-options">
            <label class="setting-toggle"><input v-model="form.useSystemProxy" type="checkbox" /><strong>先经系统代理 / V2Ray</strong></label>
            <label class="setting-toggle warning-toggle"><input v-model="form.ignoreTlsErrors" type="checkbox" /><strong>跳过代理证书认证</strong></label>
          </div>
        </fieldset>

        <div v-if="feedback.status" class="proxy-test-result" :class="feedback.status" role="status" aria-live="polite">
          <RefreshCw v-if="feedback.status === 'checking'" :size="17" class="spinning" />
          <CheckCircle2 v-else-if="feedback.status === 'success'" :size="17" />
          <AlertTriangle v-else :size="17" />
          <div><strong>{{ feedback.title }}</strong><span>{{ feedback.detail }}</span></div>
        </div>
      </div>

      <footer>
        <button class="btn-secondary" type="button" :disabled="testing || saving" @click="requestClose">取消</button>
        <button class="btn-secondary" data-smoke="quick-proxy-test" type="button" :disabled="testing || saving || !form.enabled" @click="testProxy">
          <RefreshCw :size="15" :class="{ spinning: testing }" />{{ testing ? '测试中' : '测试代理 IP' }}
        </button>
        <button class="btn-primary" type="submit" :disabled="testing || saving"><Save :size="15" />{{ saving ? '保存中' : '保存' }}</button>
      </footer>
    </form>
  </div>
</template>
