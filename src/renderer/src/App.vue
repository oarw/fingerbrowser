<script setup>
import { computed, onMounted, onUnmounted, ref } from 'vue'
import {
  AlertTriangle,
  Check,
  CircleStop,
  Cpu,
  Edit3,
  FolderCog,
  Globe2,
  LayoutGrid,
  ListFilter,
  NotebookPen,
  Play,
  Plus,
  Search,
  Settings,
  Trash2
} from 'lucide-vue-next'
import ProfileEditor from './components/ProfileEditor.vue'
import SettingsModal from './components/SettingsModal.vue'

const profiles = ref([])
const running = ref([])
const options = ref({ platforms: [], brands: [], hardwareConcurrency: [], locales: [], platformVersions: {} })
const kernelStatus = ref({ ready: false, source: 'none', managed: {} })
const search = ref('')
const statusFilter = ref('all')
const groupFilter = ref('')
const activeView = ref('profiles')
const editing = ref(null)
const selected = ref([])
const batchBusy = ref(false)
const remarkTarget = ref(null)
const remarkDraft = ref('')
const runningSet = computed(() => new Set(running.value))

let unsub = null

onMounted(async () => {
  unsub = window.api.onRunningChanged((ids) => (running.value = ids))
  const [nextOptions, nextProfiles, nextRunning, nextKernelStatus] = await Promise.all([
    window.api.fingerprintOptions(),
    window.api.listProfiles(),
    window.api.getRunning(),
    window.api.getKernelStatus()
  ])
  options.value = nextOptions
  profiles.value = nextProfiles
  running.value = nextRunning
  kernelStatus.value = nextKernelStatus
  if (!nextKernelStatus.ready) activeView.value = 'settings'
})

onUnmounted(() => {
  if (unsub) unsub()
})

async function refresh() {
  profiles.value = await window.api.listProfiles()
  selected.value = selected.value.filter((id) => profiles.value.some((profile) => profile.id === id))
}

async function refreshKernelStatus() {
  kernelStatus.value = await window.api.getKernelStatus()
}

const groups = computed(() => [...new Set(profiles.value.map((profile) => profile.group).filter(Boolean))].sort())

const filtered = computed(() => {
  const q = search.value.trim().toLowerCase()
  return profiles.value.filter((profile) => {
    if (statusFilter.value === 'running' && !isRunning(profile.id)) return false
    if (statusFilter.value === 'stopped' && isRunning(profile.id)) return false
    if (groupFilter.value && profile.group !== groupFilter.value) return false
    if (!q) return true
    return [profile.name, profile.group, profile.remark, ...(Array.isArray(profile.tags) ? profile.tags : [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(q)
  })
})

const runningCount = computed(() => profiles.value.filter((profile) => isRunning(profile.id)).length)
const allVisibleSelected = computed(
  () => filtered.value.length > 0 && filtered.value.every((profile) => selected.value.includes(profile.id))
)

function isRunning(id) {
  return runningSet.value.has(id)
}

function profileNumber(profile) {
  const index = profiles.value.findIndex((item) => item.id === profile.id)
  return `FB-${String(index + 1).padStart(3, '0')}`
}

function tagsOf(profile) {
  return Array.isArray(profile.tags) ? profile.tags : []
}

function proxyLabel(profile) {
  if (!profile.proxy?.enabled) return '本机网络'
  return `${profile.proxy.type?.toUpperCase() || 'HTTP'} · ${profile.proxy.host || '未配置'}`
}

function regionLabel(profile) {
  const timezone = profile.fingerprint?.timezone || ''
  return timezone.includes('/') ? timezone.split('/').at(-1).replaceAll('_', ' ') : timezone || '未指定'
}

function openCreate() {
  editing.value = null
  activeView.value = 'editor'
}

function openEdit(profile) {
  editing.value = profile
  activeView.value = 'editor'
}

async function onSave(payload) {
  await window.api.saveProfile(payload)
  activeView.value = 'profiles'
  await refresh()
}

async function onDelete(profile) {
  if (isRunning(profile.id)) {
    alert('请先关闭该环境再删除')
    return
  }
  if (!confirm(`确定删除环境「${profile.name}」?其独立数据目录不会被删除。`)) return
  await window.api.deleteProfile(profile.id)
  await refresh()
}

async function launch(profile) {
  try {
    await window.api.launchProfile(profile.id)
  } catch (error) {
    alert(error.message || String(error))
    await refreshKernelStatus()
  }
}

async function stop(profile) {
  await window.api.stopProfile(profile.id)
}

function toggleSelect(id) {
  const index = selected.value.indexOf(id)
  if (index >= 0) selected.value.splice(index, 1)
  else selected.value.push(id)
}

function toggleAllVisible() {
  if (allVisibleSelected.value) {
    const visible = new Set(filtered.value.map((profile) => profile.id))
    selected.value = selected.value.filter((id) => !visible.has(id))
  } else {
    selected.value = [...new Set([...selected.value, ...filtered.value.map((profile) => profile.id)])]
  }
}

async function batchLaunch(tile) {
  const ids = selected.value.filter((id) => !isRunning(id))
  if (!ids.length) {
    alert('请先选择未运行的环境')
    return
  }
  batchBusy.value = true
  try {
    const results = await window.api.launchBatch(ids, tile)
    const failures = results.filter((result) => !result.ok)
    if (failures.length) alert(`部分环境启动失败:\n${failures.map((failure) => failure.error).join('\n')}`)
  } finally {
    batchBusy.value = false
  }
}

function openRemark(profile) {
  remarkTarget.value = profile
  remarkDraft.value = profile.remark || ''
}

async function saveRemark() {
  await window.api.saveProfile({ ...remarkTarget.value, remark: remarkDraft.value.trim() })
  remarkTarget.value = null
  await refresh()
}

function openSettings() {
  activeView.value = 'settings'
}

async function settingsSaved(status) {
  if (status) kernelStatus.value = status
  else await refreshKernelStatus()
}
</script>

<template>
  <div class="app-shell">
    <aside class="sidebar">
      <div class="brand">
        <span class="brand-mark">FB</span>
        <span class="brand-name">FingerBrowser</span>
      </div>

      <nav class="primary-nav" aria-label="主导航">
        <button :class="{ active: activeView === 'profiles' || activeView === 'editor' }" @click="activeView = 'profiles'">
          <LayoutGrid :size="18" />
          <span>环境管理</span>
        </button>
        <button :class="{ active: activeView === 'settings' }" @click="openSettings">
          <FolderCog :size="18" />
          <span>内核与设置</span>
        </button>
      </nav>

      <div class="sidebar-spacer"></div>
      <div class="kernel-summary" :class="{ ready: kernelStatus.ready }">
        <Check v-if="kernelStatus.ready" :size="16" />
        <AlertTriangle v-else :size="16" />
        <div>
          <strong>{{ kernelStatus.ready ? '内核已就绪' : '内核未安装' }}</strong>
          <span>{{ kernelStatus.ready ? (kernelStatus.source === 'managed' ? kernelStatus.managed?.version : '手动路径') : '需要完成设置' }}</span>
        </div>
      </div>
    </aside>

    <main class="workspace">
      <ProfileEditor
        v-if="activeView === 'editor'"
        :profile="editing"
        :options="options"
        @close="activeView = 'profiles'"
        @save="onSave"
      />

      <SettingsModal
        v-else-if="activeView === 'settings'"
        @close="activeView = 'profiles'"
        @saved="settingsSaved"
      />

      <template v-else>
        <div class="profiles-page">
        <header class="workspace-header">
          <div>
            <p class="eyebrow">环境工作台</p>
            <h1>浏览器环境</h1>
          </div>
          <div class="header-actions">
            <button class="icon-button" title="设置" aria-label="设置" @click="openSettings">
              <Settings :size="18" />
            </button>
            <button class="btn-primary" @click="openCreate"><Plus :size="17" />新建环境</button>
          </div>
        </header>

        <div v-if="!kernelStatus.ready" class="system-notice">
          <AlertTriangle :size="18" />
          <div><strong>指纹内核未就绪</strong><span>安装或选择内核后才能启动环境。</span></div>
          <button class="btn-secondary" @click="openSettings">安装内核</button>
        </div>

        <section class="profile-workbench">
          <div class="view-tabs" role="tablist" aria-label="环境状态">
            <button :class="{ active: statusFilter === 'all' }" @click="statusFilter = 'all'">
              全部 <span>{{ profiles.length }}</span>
            </button>
            <button :class="{ active: statusFilter === 'running' }" @click="statusFilter = 'running'">
              已打开 <span>{{ runningCount }}</span>
            </button>
            <button :class="{ active: statusFilter === 'stopped' }" @click="statusFilter = 'stopped'">
              未打开 <span>{{ profiles.length - runningCount }}</span>
            </button>
          </div>

          <div class="table-toolbar">
            <div class="search-field">
              <Search :size="17" />
              <input v-model="search" placeholder="搜索名称、分组、标签或备注" />
            </div>
            <div class="filter-field">
              <ListFilter :size="16" />
              <select v-model="groupFilter" aria-label="分组筛选">
                <option value="">全部分组</option>
                <option v-for="group in groups" :key="group" :value="group">{{ group }}</option>
              </select>
            </div>
            <div class="toolbar-spacer"></div>
            <template v-if="selected.length">
              <span class="selection-count">已选 {{ selected.length }}</span>
              <button class="btn-secondary" :disabled="batchBusy" @click="batchLaunch(false)">
                <Play :size="15" />批量启动
              </button>
              <button class="btn-primary" :disabled="batchBusy" @click="batchLaunch(true)">
                <LayoutGrid :size="15" />平铺启动
              </button>
            </template>
          </div>

          <div class="profile-table-wrap">
            <table class="profile-table">
              <thead>
                <tr>
                  <th class="check-column">
                    <input type="checkbox" :checked="allVisibleSelected" aria-label="选择当前列表" @change="toggleAllVisible" />
                  </th>
                  <th>编号</th>
                  <th>环境名称</th>
                  <th>网络与地区</th>
                  <th>备注</th>
                  <th>标签 / 分组</th>
                  <th class="action-column">操作</th>
                </tr>
              </thead>
              <tbody v-if="filtered.length">
                <tr v-for="profile in filtered" :key="profile.id" :class="{ selected: selected.includes(profile.id) }">
                  <td class="check-column">
                    <input type="checkbox" :checked="selected.includes(profile.id)" :aria-label="`选择 ${profile.name}`" @change="toggleSelect(profile.id)" />
                  </td>
                  <td><span class="profile-id">{{ profileNumber(profile) }}</span></td>
                  <td>
                    <div class="profile-identity">
                      <span class="runtime-dot" :class="{ running: isRunning(profile.id) }"></span>
                      <div><strong>{{ profile.name }}</strong><span>{{ profile.fingerprint?.platform }} · {{ profile.fingerprint?.brand }}</span></div>
                    </div>
                  </td>
                  <td>
                    <div class="network-cell">
                      <span><Globe2 :size="14" />{{ regionLabel(profile) }}</span>
                      <small>{{ proxyLabel(profile) }}</small>
                    </div>
                  </td>
                  <td>
                    <button class="remark-button" :title="profile.remark || '添加备注'" @click="openRemark(profile)">
                      <NotebookPen :size="15" />
                      <span>{{ profile.remark || '添加备注' }}</span>
                    </button>
                  </td>
                  <td>
                    <div class="tag-list">
                      <span v-if="profile.group" class="group-chip">{{ profile.group }}</span>
                      <span v-for="tag in tagsOf(profile).slice(0, 2)" :key="tag" class="tag-chip">{{ tag }}</span>
                      <span v-if="tagsOf(profile).length > 2" class="tag-more">+{{ tagsOf(profile).length - 2 }}</span>
                    </div>
                  </td>
                  <td class="action-column">
                    <div class="row-actions">
                      <button v-if="!isRunning(profile.id)" class="launch-button" @click="launch(profile)"><Play :size="15" />启动</button>
                      <button v-else class="stop-button" @click="stop(profile)"><CircleStop :size="15" />关闭</button>
                      <button class="icon-button compact" title="编辑环境" :aria-label="`编辑 ${profile.name}`" @click="openEdit(profile)"><Edit3 :size="16" /></button>
                      <button class="icon-button compact danger" title="删除环境" :aria-label="`删除 ${profile.name}`" @click="onDelete(profile)"><Trash2 :size="16" /></button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>

            <div v-if="!filtered.length" class="empty-state">
              <Cpu :size="32" />
              <strong>{{ profiles.length ? '没有匹配的环境' : '还没有浏览器环境' }}</strong>
              <span>{{ profiles.length ? '调整搜索或筛选条件。' : '创建第一个独立环境开始使用。' }}</span>
              <button v-if="!profiles.length" class="btn-primary" @click="openCreate"><Plus :size="16" />新建环境</button>
            </div>
          </div>

          <footer class="table-footer">显示 {{ filtered.length }} / {{ profiles.length }} 个环境</footer>
        </section>
        </div>
      </template>
    </main>

    <div v-if="remarkTarget" class="overlay" @click.self="remarkTarget = null">
      <div class="dialog remark-dialog" role="dialog" aria-modal="true" aria-labelledby="remark-title">
        <header><div><p class="eyebrow">{{ remarkTarget.name }}</p><h2 id="remark-title">环境备注</h2></div></header>
        <div class="dialog-body">
          <label for="quick-remark">备注内容</label>
          <textarea id="quick-remark" v-model="remarkDraft" rows="5" autofocus placeholder="记录账号用途、登录状态或下一步操作"></textarea>
        </div>
        <footer>
          <button class="btn-secondary" @click="remarkTarget = null">取消</button>
          <button class="btn-primary" @click="saveRemark"><NotebookPen :size="16" />保存备注</button>
        </footer>
      </div>
    </div>
  </div>
</template>
