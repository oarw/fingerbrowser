<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import {
  ArrowLeft,
  Cpu,
  Globe2,
  Monitor,
  Network,
  Save,
  ShieldCheck,
  Shuffle,
  Tags
} from 'lucide-vue-next'

const props = defineProps({
  profile: { type: Object, default: null },
  options: { type: Object, required: true }
})
const emit = defineEmits(['close', 'save'])

function blank() {
  return {
    id: '',
    name: '',
    group: '',
    tags: '',
    remark: '',
    startupUrl: '',
    fingerprint: {
      seed: '',
      platform: 'windows',
      platformVersion: '',
      brand: 'Chrome',
      brandVersion: '',
      hardwareConcurrency: 8,
      language: 'en-US',
      acceptLanguages: 'en-US,en',
      timezone: 'America/New_York',
      webrtcMode: 'disable_non_proxied_udp'
    },
    proxy: {
      enabled: false,
      type: 'http',
      host: '',
      port: '',
      username: '',
      password: ''
    }
  }
}

const form = reactive(blank())
const platformVersions = ref([])
const geoLoading = ref(false)
const geoInfo = ref('')

const summaryRegion = computed(() => {
  const timezone = form.fingerprint.timezone || ''
  return timezone.includes('/') ? timezone.split('/').at(-1).replaceAll('_', ' ') : timezone || '未指定'
})

const summaryProxy = computed(() => {
  if (!form.proxy.enabled) return '本机网络'
  if (!form.proxy.host || !form.proxy.port) return '代理待完善'
  return `${form.proxy.type.toUpperCase()} · ${form.proxy.host}:${form.proxy.port}`
})

onMounted(async () => {
  if (props.profile) {
    Object.assign(form, JSON.parse(JSON.stringify(props.profile)))
    if (!form.tags) form.tags = ''
    if (Array.isArray(form.tags)) form.tags = form.tags.join(', ')
  } else {
    await randomizeAll()
  }
})

watch(
  () => form.fingerprint.platform,
  (platform) => {
    platformVersions.value = props.options.platformVersions?.[platform] || []
  },
  { immediate: true }
)

async function randomizeAll() {
  const fingerprint = await window.api.randomFingerprint()
  Object.assign(form.fingerprint, fingerprint)
}

async function newSeed() {
  form.fingerprint.seed = await window.api.randomSeed()
}

function applyLocale(locale) {
  form.fingerprint.language = locale.language
  form.fingerprint.acceptLanguages = locale.accept
  form.fingerprint.timezone = locale.timezone
}

async function detectGeo() {
  geoLoading.value = true
  geoInfo.value = ''
  try {
    const geo = await window.api.detectGeo(JSON.parse(JSON.stringify(form.proxy)))
    form.fingerprint.timezone = geo.timezone
    form.fingerprint.language = geo.language
    form.fingerprint.acceptLanguages = geo.acceptLanguages
    geoInfo.value = `出口 ${geo.ip} · ${geo.country} · ${geo.timezone}`
  } catch (error) {
    geoInfo.value = `查询失败:${error.message || String(error)}`
  } finally {
    geoLoading.value = false
  }
}

function submit() {
  if (!form.name.trim()) {
    alert('请填写环境名称')
    return
  }
  const payload = JSON.parse(JSON.stringify(form))
  payload.tags = String(form.tags || '')
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean)
  emit('save', payload)
}
</script>

<template>
  <div class="editor-page">
    <header class="workspace-header editor-header">
      <div class="header-title-row">
        <button class="icon-button" title="返回环境列表" aria-label="返回环境列表" @click="emit('close')"><ArrowLeft :size="19" /></button>
        <div><p class="eyebrow">{{ form.id ? '环境配置' : '新建环境' }}</p><h1>{{ form.id ? form.name || '编辑环境' : '创建浏览器环境' }}</h1></div>
      </div>
      <button class="btn-primary" @click="submit"><Save :size="16" />{{ form.id ? '保存更改' : '创建环境' }}</button>
    </header>

    <div class="editor-content">
      <div class="editor-form">
        <section class="form-section">
          <div class="section-heading"><div><h2>基础信息</h2><p>用于在环境列表中识别和检索账号。</p></div></div>
          <div class="form-grid">
            <div><label for="profile-name">环境名称 *</label><input id="profile-name" v-model="form.name" placeholder="例如 Amazon-US-01" /></div>
            <div><label for="profile-group">分组</label><input id="profile-group" v-model="form.group" placeholder="例如 电商主账号" /></div>
            <div class="full"><label for="profile-tags">标签</label><div class="input-with-icon"><Tags :size="16" /><input id="profile-tags" v-model="form.tags" placeholder="美国, 主号, 待养号" /></div></div>
            <div class="full"><label for="profile-remark">备注</label><textarea id="profile-remark" v-model="form.remark" rows="3" placeholder="记录账号用途、登录状态或下一步操作"></textarea></div>
            <div class="full"><label for="startup-url">起始页</label><input id="startup-url" v-model="form.startupUrl" placeholder="留空则使用系统默认起始页" /></div>
          </div>
        </section>

        <section class="form-section">
          <div class="section-heading">
            <div><h2>代理与地区</h2><p>代理出口、语言和时区应保持一致。</p></div>
            <label class="toggle-control"><input v-model="form.proxy.enabled" type="checkbox" /><span></span>启用代理</label>
          </div>

          <div v-if="form.proxy.enabled" class="form-grid proxy-grid">
            <div><label for="proxy-type">代理类型</label><select id="proxy-type" v-model="form.proxy.type"><option value="http">HTTP / HTTPS</option><option value="socks5">SOCKS5</option></select></div>
            <div><label for="proxy-host">主机</label><input id="proxy-host" v-model="form.proxy.host" placeholder="127.0.0.1" /></div>
            <div><label for="proxy-port">端口</label><input id="proxy-port" v-model="form.proxy.port" placeholder="7890" /></div>
            <div><label for="proxy-user">用户名</label><input id="proxy-user" v-model="form.proxy.username" autocomplete="off" /></div>
            <div><label for="proxy-password">密码</label><input id="proxy-password" v-model="form.proxy.password" type="password" autocomplete="new-password" /></div>
            <div class="geo-action"><button class="btn-secondary" type="button" :disabled="geoLoading" @click="detectGeo"><Globe2 :size="16" />{{ geoLoading ? '正在检测' : '按出口 IP 匹配地区' }}</button></div>
            <div v-if="geoInfo" class="full inline-message">{{ geoInfo }}</div>
          </div>
          <div v-else class="disabled-section"><Network :size="20" /><span>当前环境使用本机网络。</span></div>
        </section>

        <section class="form-section">
          <div class="section-heading"><div><h2>指纹配置</h2><p>种子决定 Canvas、WebGL、音频和字体等内核级特征。</p></div><button class="btn-secondary" type="button" @click="randomizeAll"><Shuffle :size="16" />一键随机</button></div>
          <div class="form-grid">
            <div class="full"><label for="fingerprint-seed">指纹种子</label><div class="inline-control"><input id="fingerprint-seed" v-model="form.fingerprint.seed" placeholder="32 位整数" /><button class="btn-secondary" type="button" @click="newSeed"><Shuffle :size="15" />换一个</button></div></div>
            <div><label for="platform">操作系统</label><select id="platform" v-model="form.fingerprint.platform"><option v-for="platform in options.platforms" :key="platform" :value="platform">{{ platform }}</option></select></div>
            <div><label for="platform-version">系统版本</label><input id="platform-version" v-model="form.fingerprint.platformVersion" list="platform-version-list" placeholder="使用内核默认" /><datalist id="platform-version-list"><option v-for="version in platformVersions" :key="version" :value="version" /></datalist></div>
            <div><label for="brand">浏览器品牌</label><select id="brand" v-model="form.fingerprint.brand"><option v-for="brand in options.brands" :key="brand" :value="brand">{{ brand }}</option></select></div>
            <div><label for="brand-version">品牌版本</label><input id="brand-version" v-model="form.fingerprint.brandVersion" placeholder="使用内核默认" /></div>
            <div><label for="cpu-count">CPU 核心数</label><select id="cpu-count" v-model.number="form.fingerprint.hardwareConcurrency"><option v-for="count in options.hardwareConcurrency" :key="count" :value="count">{{ count }}</option></select></div>
            <div><label for="webrtc">WebRTC</label><select id="webrtc" v-model="form.fingerprint.webrtcMode"><option value="disable_non_proxied_udp">禁止非代理 UDP</option><option value="off">不处理</option></select></div>
            <div><label for="language">界面语言</label><input id="language" v-model="form.fingerprint.language" placeholder="en-US" /></div>
            <div><label for="accept-language">接受语言</label><input id="accept-language" v-model="form.fingerprint.acceptLanguages" placeholder="en-US,en" /></div>
            <div class="full"><label for="timezone">时区</label><input id="timezone" v-model="form.fingerprint.timezone" placeholder="America/New_York" /></div>
            <div class="full locale-presets"><span>快速地区</span><button v-for="locale in options.locales" :key="locale.timezone" type="button" :class="{ active: form.fingerprint.timezone === locale.timezone }" @click="applyLocale(locale)">{{ locale.language }} · {{ locale.timezone.split('/').at(-1) }}</button></div>
          </div>
        </section>
      </div>

      <aside class="environment-summary">
        <div class="summary-heading"><div><p class="eyebrow">实时摘要</p><h2>{{ form.name || '未命名环境' }}</h2></div><ShieldCheck :size="21" /></div>
        <div class="device-visual"><Monitor :size="64" stroke-width="1.4" /><span>{{ form.fingerprint.platform }}</span></div>
        <dl>
          <div><dt><Monitor :size="15" />系统</dt><dd>{{ form.fingerprint.platform }} {{ form.fingerprint.platformVersion }}</dd></div>
          <div><dt><Cpu :size="15" />内核特征</dt><dd>{{ form.fingerprint.brand }} · {{ form.fingerprint.hardwareConcurrency }} 核</dd></div>
          <div><dt><Globe2 :size="15" />地区</dt><dd>{{ summaryRegion }} · {{ form.fingerprint.language }}</dd></div>
          <div><dt><Network :size="15" />网络</dt><dd>{{ summaryProxy }}</dd></div>
        </dl>
        <div class="seed-summary"><span>指纹种子</span><strong>{{ form.fingerprint.seed || '未生成' }}</strong></div>
        <button class="btn-secondary summary-random" type="button" @click="randomizeAll"><Shuffle :size="16" />重新生成整套指纹</button>
      </aside>
    </div>
  </div>
</template>
