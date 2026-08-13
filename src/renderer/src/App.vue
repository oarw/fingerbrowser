<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue'
import ProfileEditor from './components/ProfileEditor.vue'
import SettingsModal from './components/SettingsModal.vue'

const profiles = ref([])
const running = ref([])
const options = ref({ platforms: [], brands: [], hardwareConcurrency: [], locales: [], platformVersions: {} })
const search = ref('')

const showEditor = ref(false)
const editing = ref(null)
const showSettings = ref(false)

const selected = ref([])
const batchBusy = ref(false)
const runningSet = computed(() => new Set(running.value))

let unsub = null

onMounted(async () => {
  unsub = window.api.onRunningChanged((ids) => (running.value = ids))
  const [nextOptions, nextProfiles, nextRunning] = await Promise.all([
    window.api.fingerprintOptions(),
    window.api.listProfiles(),
    window.api.getRunning()
  ])
  options.value = nextOptions
  profiles.value = nextProfiles
  running.value = nextRunning
})

onUnmounted(() => {
  if (unsub) unsub()
})

async function refresh() {
  profiles.value = await window.api.listProfiles()
}

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  if (!q) return profiles.value
  return profiles.value.filter((p) =>
    [p.name, p.group, p.remark, ...(Array.isArray(p.tags) ? p.tags : [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q)
  )
})

function isRunning(id) {
  return runningSet.value.has(id)
}

function openCreate() {
  editing.value = null
  showEditor.value = true
}
function openEdit(p) {
  editing.value = p
  showEditor.value = true
}

async function onSave(payload) {
  await window.api.saveProfile(payload)
  showEditor.value = false
  await refresh()
}

async function onDelete(p) {
  if (isRunning(p.id)) {
    alert('请先关闭该环境再删除')
    return
  }
  if (!confirm(`确定删除环境「${p.name}」?其独立数据目录不会被删除。`)) return
  await window.api.deleteProfile(p.id)
  await refresh()
}

async function launch(p) {
  try {
    await window.api.launchProfile(p.id)
  } catch (e) {
    alert(e.message || String(e))
  }
}

async function stop(p) {
  await window.api.stopProfile(p.id)
}

function tagsOf(p) {
  return Array.isArray(p.tags) ? p.tags : []
}

function isSelected(id) {
  return selected.value.includes(id)
}
function toggleSelect(id) {
  const i = selected.value.indexOf(id)
  if (i >= 0) selected.value.splice(i, 1)
  else selected.value.push(id)
}
function selectAllFiltered() {
  selected.value = filtered.value.map((p) => p.id)
}
function clearSel() {
  selected.value = []
}

async function batchLaunch(tile) {
  const ids = selected.value.filter((id) => !isRunning(id))
  if (!ids.length) {
    alert('请先勾选未运行的环境')
    return
  }
  batchBusy.value = true
  try {
    const res = await window.api.launchBatch(ids, tile)
    const fails = res.filter((r) => !r.ok)
    if (fails.length) alert('部分环境启动失败:\n' + fails.map((f) => f.error).join('\n'))
  } finally {
    batchBusy.value = false
  }
}
</script>

<template>
  <div class="app">
    <div class="topbar">
      <div class="logo">Finger<span>Browser</span></div>
      <div class="spacer"></div>
      <input class="search" v-model="search" placeholder="搜索环境 / 分组 / 标签" />
      <button class="btn-ghost" @click="showSettings = true">设置</button>
      <button class="btn-primary" @click="openCreate">+ 新建环境</button>
    </div>

    <div v-if="profiles.length" class="subbar">
      <span class="sel-count">已选 {{ selected.length }} 个</span>
      <button class="btn-ghost" @click="selectAllFiltered">全选</button>
      <button class="btn-ghost" @click="clearSel">清空</button>
      <div class="spacer" style="flex: 1"></div>
      <button class="btn-ghost" :disabled="batchBusy || !selected.length" @click="batchLaunch(false)">
        批量启动
      </button>
      <button class="btn-primary" :disabled="batchBusy || !selected.length" @click="batchLaunch(true)">
        平铺启动
      </button>
    </div>

    <div class="content">
      <div v-if="filtered.length" class="grid">
        <div v-for="p in filtered" :key="p.id" class="card">
          <div class="row">
            <input
              type="checkbox"
              class="card-check"
              :checked="isSelected(p.id)"
              @change="toggleSelect(p.id)"
            />
            <span class="dot" :class="isRunning(p.id) ? 'running' : 'stopped'"></span>
            <span class="name">{{ p.name }}</span>
            <div class="spacer" style="flex: 1"></div>
            <span v-if="p.group" class="tag">{{ p.group }}</span>
          </div>
          <div class="meta">
            {{ p.fingerprint?.platform }} · {{ p.fingerprint?.brand }} · seed
            {{ p.fingerprint?.seed || '—' }}<br />
            {{ p.fingerprint?.timezone }} · {{ p.fingerprint?.language }}
            <template v-if="p.proxy?.enabled">
              <br />代理 {{ p.proxy.type }}://{{ p.proxy.host }}:{{ p.proxy.port }}
            </template>
          </div>
          <div class="row" v-if="tagsOf(p).length" style="flex-wrap: wrap; gap: 6px">
            <span v-for="t in tagsOf(p)" :key="t" class="tag">{{ t }}</span>
          </div>
          <div class="actions">
            <button
              v-if="!isRunning(p.id)"
              class="btn-primary"
              @click="launch(p)"
            >
              启动
            </button>
            <button v-else class="btn-ghost" @click="stop(p)">关闭</button>
            <button class="btn-ghost" @click="openEdit(p)">编辑</button>
            <div class="spacer"></div>
            <button class="btn-danger" @click="onDelete(p)">删除</button>
          </div>
        </div>
      </div>
      <div v-else class="empty">
        <p>还没有环境。点击右上角「新建环境」创建第一个隔离环境。</p>
        <p class="hint">提示:首次使用请先在「设置」里指定 fingerprint-chromium 内核路径。</p>
      </div>
    </div>

    <ProfileEditor
      v-if="showEditor"
      :profile="editing"
      :options="options"
      @close="showEditor = false"
      @save="onSave"
    />
    <SettingsModal v-if="showSettings" @close="showSettings = false" @saved="refresh" />
  </div>
</template>
