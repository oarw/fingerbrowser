<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from 'vue'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Download,
  ExternalLink,
  FileSearch,
  FolderOpen,
  HardDriveDownload,
  PauseCircle,
  Save
} from 'lucide-vue-next'

const emit = defineEmits(['close', 'saved'])

const form = reactive({ kernelPath: '', managedKernelVersion: '', defaultStartupUrl: '' })
const status = ref({ ready: false, source: 'none', managed: {}, progress: { stage: 'idle', percent: 0 } })
const progress = ref({ stage: 'idle', received: 0, total: 0, percent: 0 })
const error = ref('')
const saving = ref(false)

let unsubscribe = null

const isInstalling = computed(() => ['downloading', 'verifying', 'extracting'].includes(progress.value.stage))
const progressLabel = computed(() => {
  const labels = {
    downloading: '正在下载',
    verifying: '正在校验 SHA-256',
    extracting: '正在安装',
    paused: '下载已暂停',
    ready: '安装完成',
    error: '安装失败'
  }
  return labels[progress.value.stage] || ''
})

const installButtonLabel = computed(() => {
  if (isInstalling.value) return progressLabel.value
  if (status.value.managed?.installed && status.value.source !== 'managed') return '启用已安装内核'
  if (status.value.source === 'managed') return '内核已安装'
  if (progress.value.stage === 'paused') return '继续下载'
  return '下载并安装'
})

function formatBytes(value) {
  if (!value) return '0 MB'
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}

onMounted(async () => {
  unsubscribe = window.api.onKernelProgress((next) => (progress.value = next))
  const [settings, nextStatus] = await Promise.all([window.api.getSettings(), window.api.getKernelStatus()])
  Object.assign(form, settings)
  status.value = nextStatus
  progress.value = nextStatus.progress || progress.value
})

onUnmounted(() => {
  if (unsubscribe) unsubscribe()
})

async function install() {
  if (status.value.source === 'managed') return
  error.value = ''
  try {
    const nextStatus = await window.api.installKernel()
    status.value = nextStatus
    progress.value = nextStatus.progress
    form.kernelPath = nextStatus.configuredPath
    form.managedKernelVersion = nextStatus.managed.version
    emit('saved', nextStatus)
  } catch (installError) {
    error.value = installError.message || String(installError)
  }
}

async function cancelInstall() {
  await window.api.cancelKernelInstall()
}

async function pick() {
  const path = await window.api.pickKernel()
  if (path) form.kernelPath = path
}

async function openDirectory() {
  const errorMessage = await window.api.openKernelDirectory()
  if (errorMessage) error.value = errorMessage
}

async function openSource() {
  await window.api.openKernelSource()
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    await window.api.setSettings(JSON.parse(JSON.stringify(form)))
    const nextStatus = await window.api.getKernelStatus()
    status.value = nextStatus
    emit('saved', nextStatus)
  } catch (saveError) {
    error.value = saveError.message || String(saveError)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <div class="settings-page">
    <header class="workspace-header settings-header">
      <div class="header-title-row">
        <button class="icon-button" title="返回环境列表" aria-label="返回环境列表" @click="emit('close')"><ArrowLeft :size="19" /></button>
        <div><p class="eyebrow">系统配置</p><h1>内核与设置</h1></div>
      </div>
      <button class="btn-primary" :disabled="saving" @click="save"><Save :size="16" />保存设置</button>
    </header>

    <div class="settings-content">
      <section class="settings-section">
        <div class="section-heading">
          <div><h2>指纹内核</h2><p>官方稳定版经过固定大小和 SHA-256 双重校验后才会启用。</p></div>
          <span class="status-badge" :class="{ ready: status.ready }">
            <CheckCircle2 v-if="status.ready" :size="15" />
            <AlertTriangle v-else :size="15" />
            {{ status.ready ? '可以启动' : '尚未就绪' }}
          </span>
        </div>

        <div class="kernel-panel">
          <div class="kernel-icon"><HardDriveDownload :size="28" /></div>
          <div class="kernel-details">
            <strong>{{ status.managed?.label || 'Chromium 148 · Windows x64' }}</strong>
            <span>版本 {{ status.managed?.version || '148.0.7778.215' }} · {{ formatBytes(status.managed?.size || 189767686) }}</span>
            <small v-if="status.source === 'managed'">内置管理 · {{ status.configuredPath }}</small>
            <small v-else-if="status.source === 'manual'">手动路径 · {{ status.configuredPath }}</small>
            <small v-else>未配置可用内核</small>
          </div>
          <button
            class="btn-primary"
            :disabled="isInstalling || status.source === 'managed'"
            @click="install"
          >
            <Download :size="16" />{{ installButtonLabel }}
          </button>
        </div>

        <div v-if="isInstalling || progress.stage === 'paused'" class="download-progress">
          <div class="progress-copy"><span>{{ progressLabel }}</span><strong>{{ progress.percent || 0 }}%</strong></div>
          <div class="progress-track"><span :style="{ width: `${progress.percent || 0}%` }"></span></div>
          <div class="progress-meta">
            <span>{{ formatBytes(progress.received) }} / {{ formatBytes(progress.total || status.managed?.size) }}</span>
            <button v-if="isInstalling" class="text-button" @click="cancelInstall"><PauseCircle :size="14" />暂停</button>
          </div>
        </div>

        <div v-if="error" class="error-message"><AlertTriangle :size="16" />{{ error }}</div>

        <div class="kernel-actions">
          <button class="btn-secondary" @click="openDirectory"><FolderOpen :size="16" />打开内核目录</button>
          <button class="text-button" @click="openSource"><ExternalLink :size="14" />官方来源 · BSD-3-Clause</button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-heading"><div><h2>手动内核</h2><p>用于测试其他兼容内核，保存后会覆盖当前启动路径。</p></div></div>
        <label for="kernel-path">Chromium 可执行文件</label>
        <div class="inline-control">
          <input id="kernel-path" v-model="form.kernelPath" placeholder="C:\\...\\chrome.exe" />
          <button class="btn-secondary" type="button" @click="pick"><FileSearch :size="16" />浏览</button>
        </div>
      </section>

      <section class="settings-section">
        <div class="section-heading"><div><h2>启动行为</h2><p>环境没有单独填写起始页时使用此地址。</p></div></div>
        <label for="startup-url">默认起始页</label>
        <input id="startup-url" v-model="form.defaultStartupUrl" placeholder="https://browserleaks.com/canvas" />
      </section>
    </div>
  </div>
</template>
