<script setup>
import { reactive, ref, watch, onMounted } from 'vue'

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

onMounted(() => {
  if (props.profile) {
    Object.assign(form, JSON.parse(JSON.stringify(props.profile)))
    if (!form.tags) form.tags = ''
    if (Array.isArray(form.tags)) form.tags = form.tags.join(', ')
  } else {
    randomizeAll()
  }
})

const platformVersions = ref([])
watch(
  () => form.fingerprint.platform,
  (p) => {
    platformVersions.value = props.options.platformVersions?.[p] || []
  },
  { immediate: true }
)

async function randomizeAll() {
  const fp = await window.api.randomFingerprint()
  Object.assign(form.fingerprint, fp)
}

async function newSeed() {
  form.fingerprint.seed = await window.api.randomSeed()
}

function applyLocale(loc) {
  form.fingerprint.language = loc.language
  form.fingerprint.acceptLanguages = loc.accept
  form.fingerprint.timezone = loc.timezone
}

const geoLoading = ref(false)
const geoInfo = ref('')
async function detectGeo() {
  geoLoading.value = true
  geoInfo.value = ''
  try {
    const g = await window.api.detectGeo(JSON.parse(JSON.stringify(form.proxy)))
    form.fingerprint.timezone = g.timezone
    form.fingerprint.language = g.language
    form.fingerprint.acceptLanguages = g.acceptLanguages
    geoInfo.value = `出口 IP ${g.ip} · ${g.country} · ${g.timezone}`
  } catch (e) {
    geoInfo.value = '查询失败:' + (e.message || String(e))
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
    .map((t) => t.trim())
    .filter(Boolean)
  emit('save', payload)
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal">
      <header>{{ form.id ? '编辑环境' : '新建环境' }}</header>
      <div class="body">
        <div class="form-grid">
          <div>
            <label>环境名称 *</label>
            <input v-model="form.name" placeholder="例如 Amazon-US-01" />
          </div>
          <div>
            <label>分组</label>
            <input v-model="form.group" placeholder="例如 TikTok" />
          </div>
          <div class="full">
            <label>标签(逗号分隔)</label>
            <input v-model="form.tags" placeholder="美国, 主号" />
          </div>
          <div class="full">
            <label>起始页 URL</label>
            <input v-model="form.startupUrl" placeholder="https://browserleaks.com/canvas" />
          </div>
          <div class="full">
            <label>备注</label>
            <input v-model="form.remark" placeholder="可选" />
          </div>

          <div class="section-title">指纹</div>
          <div class="full">
            <label>指纹种子(seed,决定 Canvas/WebGL/音频/GPU 等)</label>
            <div class="inline">
              <input v-model="form.fingerprint.seed" placeholder="留空则不伪装" />
              <button class="btn-ghost" type="button" @click="newSeed">随机种子</button>
              <button class="btn-ghost" type="button" @click="randomizeAll">全部随机</button>
            </div>
          </div>
          <div>
            <label>操作系统</label>
            <select v-model="form.fingerprint.platform">
              <option v-for="p in options.platforms" :key="p" :value="p">{{ p }}</option>
            </select>
          </div>
          <div>
            <label>系统版本</label>
            <input
              v-model="form.fingerprint.platformVersion"
              list="pv-list"
              placeholder="留空用默认"
            />
            <datalist id="pv-list">
              <option v-for="v in platformVersions" :key="v" :value="v" />
            </datalist>
          </div>
          <div>
            <label>浏览器品牌</label>
            <select v-model="form.fingerprint.brand">
              <option v-for="b in options.brands" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>
          <div>
            <label>品牌版本</label>
            <input v-model="form.fingerprint.brandVersion" placeholder="留空用默认" />
          </div>
          <div>
            <label>CPU 核心数</label>
            <select v-model.number="form.fingerprint.hardwareConcurrency">
              <option v-for="n in options.hardwareConcurrency" :key="n" :value="n">{{ n }}</option>
            </select>
          </div>
          <div>
            <label>WebRTC</label>
            <select v-model="form.fingerprint.webrtcMode">
              <option value="disable_non_proxied_udp">禁止非代理 UDP(防泄漏,推荐)</option>
              <option value="off">不处理</option>
            </select>
          </div>
          <div>
            <label>界面语言 (--lang)</label>
            <input v-model="form.fingerprint.language" placeholder="en-US" />
          </div>
          <div>
            <label>接受语言 (--accept-lang)</label>
            <input v-model="form.fingerprint.acceptLanguages" placeholder="en-US,en" />
          </div>
          <div class="full">
            <label>时区</label>
            <div class="inline">
              <input v-model="form.fingerprint.timezone" placeholder="America/New_York" />
              <button class="btn-ghost" type="button" :disabled="geoLoading" @click="detectGeo">
                {{ geoLoading ? '查询中…' : '按代理 IP 填充' }}
              </button>
            </div>
            <div v-if="geoInfo" class="hint" style="margin-top: 6px">{{ geoInfo }}</div>
          </div>
          <div class="full">
            <label>快速套用地区(语言 + 时区)</label>
            <div class="inline" style="flex-wrap: wrap">
              <button
                v-for="loc in options.locales"
                :key="loc.timezone"
                class="btn-ghost"
                type="button"
                @click="applyLocale(loc)"
              >
                {{ loc.language }} · {{ loc.timezone.split('/')[1] }}
              </button>
            </div>
          </div>

          <div class="section-title">代理</div>
          <div class="full switch">
            <input id="proxy-enabled" type="checkbox" v-model="form.proxy.enabled" />
            <label for="proxy-enabled" style="margin: 0">启用代理</label>
          </div>
          <template v-if="form.proxy.enabled">
            <div>
              <label>类型</label>
              <select v-model="form.proxy.type">
                <option value="http">HTTP</option>
                <option value="socks5">SOCKS5</option>
              </select>
            </div>
            <div>
              <label>主机</label>
              <input v-model="form.proxy.host" placeholder="127.0.0.1" />
            </div>
            <div>
              <label>端口</label>
              <input v-model="form.proxy.port" placeholder="7890" />
            </div>
            <div></div>
            <div>
              <label>用户名</label>
              <input v-model="form.proxy.username" />
            </div>
            <div>
              <label>密码</label>
              <input v-model="form.proxy.password" type="password" />
            </div>
            <div class="full hint">
              带账号密码的代理或 SOCKS5 会自动经本地桥接转发(浏览器只连 127.0.0.1,凭据不外泄)。
            </div>
          </template>
        </div>
      </div>
      <footer>
        <button class="btn-ghost" @click="emit('close')">取消</button>
        <button class="btn-primary" @click="submit">保存</button>
      </footer>
    </div>
  </div>
</template>
