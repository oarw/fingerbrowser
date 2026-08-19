<script setup>
import { computed, nextTick, onMounted, reactive, ref } from 'vue'
import {
  AlertTriangle,
  CheckCircle2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Users,
  X
} from 'lucide-vue-next'

const props = defineProps({
  assignIds: { type: Array, default: () => [] }
})
const emit = defineEmits(['close', 'changed', 'assigned'])

function blank() {
  return {
    id: '',
    name: '',
    proxy: {
      enabled: true,
      type: 'http',
      host: '',
      port: '',
      username: '',
      password: '',
      useSystemProxy: true,
      ignoreTlsErrors: false
    }
  }
}

const entries = ref([])
const form = reactive(blank())
const busy = ref(false)
const testing = ref(false)
const feedback = reactive({ status: '', title: '', detail: '' })
const hasTargets = computed(() => props.assignIds.length > 0)

onMounted(async () => {
  await refresh()
  await nextTick()
  document.querySelector('#proxy-library-name')?.focus()
})

async function refresh(preferredId = '') {
  entries.value = await window.api.listProxyLibrary()
  const next = entries.value.find((entry) => entry.id === preferredId) || entries.value[0]
  if (next) selectEntry(next)
  else newEntry()
}

function clearFeedback() {
  Object.assign(feedback, { status: '', title: '', detail: '' })
}

function selectEntry(entry) {
  Object.assign(form, JSON.parse(JSON.stringify(entry)))
  form.proxy.enabled = true
  clearFeedback()
}

function newEntry() {
  Object.assign(form, blank())
  clearFeedback()
  void nextTick(() => document.querySelector('#proxy-library-name')?.focus())
}

function payload() {
  return {
    id: form.id,
    name: form.name.trim(),
    proxy: {
      enabled: true,
      type: form.proxy.type,
      host: form.proxy.host.trim(),
      port: String(form.proxy.port || '').trim(),
      username: form.proxy.username.trim(),
      password: form.proxy.password,
      useSystemProxy: form.proxy.useSystemProxy,
      ignoreTlsErrors: form.proxy.ignoreTlsErrors
    }
  }
}

async function saveEntry() {
  busy.value = true
  clearFeedback()
  try {
    const saved = await window.api.saveProxyEntry(payload())
    await refresh(saved.id)
    emit('changed')
    Object.assign(feedback, { status: 'success', title: '代理已保存', detail: `${saved.proxy.host}:${saved.proxy.port}` })
  } catch (error) {
    Object.assign(feedback, { status: 'error', title: '无法保存代理', detail: error.message || String(error) })
  } finally {
    busy.value = false
  }
}

async function deleteEntry() {
  if (!form.id || !window.confirm(`删除代理「${form.name}」？已分配环境不会被修改。`)) return
  busy.value = true
  try {
    await window.api.deleteProxyEntry(form.id)
    await refresh()
    emit('changed')
  } finally {
    busy.value = false
  }
}

async function testEntry() {
  if (!form.proxy.host.trim() || !String(form.proxy.port || '').trim()) {
    Object.assign(feedback, { status: 'error', title: '无法测试代理', detail: '请填写主机和端口' })
    return
  }
  testing.value = true
  Object.assign(feedback, { status: 'checking', title: '正在检测代理出口', detail: '正在查询出口 IP...' })
  try {
    const geo = await window.api.detectGeo(payload().proxy)
    Object.assign(feedback, {
      status: 'success',
      title: `代理可用 · ${geo.ip}`,
      detail: [geo.country || geo.countryCode, geo.timezone].filter(Boolean).join(' · ')
    })
  } catch (error) {
    Object.assign(feedback, { status: 'error', title: '代理测试失败', detail: error.message || String(error) })
  } finally {
    testing.value = false
  }
}

async function assign(entryId) {
  if (!hasTargets.value) return
  busy.value = true
  try {
    const result = await window.api.assignProxyEntry(props.assignIds, entryId)
    emit('assigned', result)
  } catch (error) {
    Object.assign(feedback, { status: 'error', title: '代理分配失败', detail: error.message || String(error) })
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog proxy-library-dialog" data-smoke="proxy-library-dialog" role="dialog" aria-modal="true" aria-labelledby="proxy-library-title">
      <header class="quick-proxy-header">
        <div>
          <p class="eyebrow">{{ hasTargets ? `分配到 ${assignIds.length} 个环境` : '可复用网络端点' }}</p>
          <h2 id="proxy-library-title">代理库</h2>
        </div>
        <button class="icon-button compact" data-smoke="proxy-library-close" type="button" title="关闭" aria-label="关闭" @click="emit('close')"><X :size="17" /></button>
      </header>

      <div class="proxy-library-layout">
        <aside class="proxy-library-list">
          <div class="proxy-library-list-head">
            <strong>已保存代理</strong>
            <button class="icon-button compact" type="button" title="添加代理" aria-label="添加代理" @click="newEntry"><Plus :size="16" /></button>
          </div>
          <button
            v-for="entry in entries"
            :key="entry.id"
            type="button"
            class="proxy-library-row"
            :class="{ active: form.id === entry.id }"
            @click="selectEntry(entry)"
          >
            <Network :size="15" />
            <span><strong>{{ entry.name }}</strong><small>{{ entry.proxy.type.toUpperCase() }} · {{ entry.proxy.host }}:{{ entry.proxy.port }}</small></span>
          </button>
          <div v-if="!entries.length" class="proxy-library-empty">还没有保存的代理</div>
        </aside>

        <form class="proxy-library-form" @submit.prevent="saveEntry">
          <div class="proxy-library-title-row">
            <div>
              <label for="proxy-library-name">名称</label>
              <input id="proxy-library-name" v-model="form.name" placeholder="例如 香港住宅 01" />
            </div>
            <button v-if="form.id" class="icon-button compact danger" type="button" title="删除代理" aria-label="删除代理" :disabled="busy" @click="deleteEntry"><Trash2 :size="16" /></button>
          </div>

          <div class="quick-proxy-endpoint">
            <div><label for="library-proxy-type">协议</label><select id="library-proxy-type" v-model="form.proxy.type"><option value="http">HTTP</option><option value="https">HTTPS</option><option value="socks5">SOCKS5</option></select></div>
            <div><label for="library-proxy-host">主机</label><input id="library-proxy-host" v-model="form.proxy.host" placeholder="127.0.0.1" /></div>
            <div><label for="library-proxy-port">端口</label><input id="library-proxy-port" v-model="form.proxy.port" inputmode="numeric" placeholder="7890" /></div>
          </div>

          <div class="quick-proxy-credentials">
            <div><label for="library-proxy-user">用户名</label><input id="library-proxy-user" v-model="form.proxy.username" autocomplete="off" placeholder="可选" /></div>
            <div><label for="library-proxy-password">密码</label><input id="library-proxy-password" v-model="form.proxy.password" type="password" autocomplete="new-password" placeholder="可选" /></div>
          </div>

          <div class="quick-proxy-options">
            <label class="setting-toggle"><input v-model="form.proxy.useSystemProxy" type="checkbox" /><strong>先经系统代理 / V2Ray</strong></label>
            <label class="setting-toggle warning-toggle"><input v-model="form.proxy.ignoreTlsErrors" type="checkbox" /><strong>跳过代理证书认证</strong></label>
          </div>

          <div v-if="feedback.status" class="proxy-test-result" :class="feedback.status" role="status">
            <RefreshCw v-if="feedback.status === 'checking'" :size="17" class="spinning" />
            <CheckCircle2 v-else-if="feedback.status === 'success'" :size="17" />
            <AlertTriangle v-else :size="17" />
            <div><strong>{{ feedback.title }}</strong><span>{{ feedback.detail }}</span></div>
          </div>

          <div class="proxy-library-form-actions">
            <button class="btn-secondary" type="button" :disabled="busy || testing" @click="testEntry"><RefreshCw :size="15" :class="{ spinning: testing }" />测试</button>
            <button class="btn-primary" type="submit" :disabled="busy || testing"><Save :size="15" />保存代理</button>
          </div>
        </form>
      </div>

      <footer v-if="hasTargets" class="proxy-library-assign">
        <button class="btn-secondary" type="button" :disabled="busy" @click="assign('')"><Network :size="15" />设为本机网络</button>
        <div class="toolbar-spacer"></div>
        <span><Users :size="15" />已选 {{ assignIds.length }} 个环境</span>
        <button class="btn-primary" type="button" :disabled="busy || !form.id" @click="assign(form.id)">分配所选代理</button>
      </footer>
    </div>
  </div>
</template>
