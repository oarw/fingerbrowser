<script setup>
import { reactive, onMounted } from 'vue'

const emit = defineEmits(['close', 'saved'])

const form = reactive({
  kernelPath: '',
  defaultStartupUrl: ''
})

onMounted(async () => {
  const s = await window.api.getSettings()
  Object.assign(form, s)
})

async function pick() {
  const p = await window.api.pickKernel()
  if (p) form.kernelPath = p
}

async function save() {
  await window.api.setSettings(JSON.parse(JSON.stringify(form)))
  emit('saved')
  emit('close')
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="modal" style="width: 560px">
      <header>设置</header>
      <div class="body">
        <div class="banner">
          本工具只做“环境管理 + 启动”,真正的指纹伪装由内核完成。请先下载
          <b>fingerprint-chromium</b>(基于 ungoogled-chromium),解压后在下方指定它的
          chrome(.exe) 路径。
        </div>
        <label>内核路径(fingerprint-chromium 的 chrome.exe)</label>
        <div class="inline">
          <input v-model="form.kernelPath" placeholder="C:\\...\\chrome.exe" />
          <button class="btn-ghost" type="button" @click="pick">浏览</button>
        </div>
        <div style="height: 16px"></div>
        <label>默认起始页</label>
        <input v-model="form.defaultStartupUrl" placeholder="https://browserleaks.com/canvas" />
      </div>
      <footer>
        <button class="btn-ghost" @click="emit('close')">取消</button>
        <button class="btn-primary" @click="save">保存</button>
      </footer>
    </div>
  </div>
</template>
