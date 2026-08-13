# FingerBrowser 交接文档

> 面向接手者。读完这份就能独立开发、构建、发布本项目。

## 1. 这是什么

一个**自研指纹浏览器管理器**,用来替代臃肿、有广告和限制的商业指纹浏览器(如 RoxyBrowser)。

它自己**不做指纹伪装**,而是负责"多环境管理 + 隔离 + 启动";真正的指纹伪装交给一个**内核级指纹 Chromium**(外部程序,单独下载)。这样能拿到接近商业产品的反检测能力,而我们只维护"管理器"这层。

- 仓库:`https://github.com/oarw/fingerbrowser`(私有)
- 技术栈:Electron + Vue 3 + Vite(经由 electron-vite)
- 目标平台:当前 Windows,架构预留 macOS / Linux

## 2. 三层架构

```
┌─────────────────────────────────────────┐
│  管理器 GUI (Electron 渲染进程 · Vue 3)   │  本仓库
│  环境增删改查 / 指纹编辑 / 代理 / 批量     │
├─────────────────────────────────────────┤
│  管理器主进程 (Electron main · Node)      │  本仓库
│  持久化 / 启动引擎 / 代理桥接 / IP 地理    │
├─────────────────────────────────────────┤
│  内核级指纹 Chromium (fingerprint-chromium)│  外部,单独下载
│  Canvas/WebGL/音频/字体/时区/GPU 伪装      │
└─────────────────────────────────────────┘
```

**关键理念**:指纹伪装发生在 C++ 内核层(不是 JS 注入),所以 `.toString()` 返回 `[native code]`,能过 CreepJS / BrowserLeaks / Cloudflare Turnstile。管理器通过**命令行参数**驱动内核,一个环境 = 一个内核进程 = 一个独立 `--user-data-dir`。

## 3. 目录结构

```
fingerbrowser/
├─ package.json              依赖与脚本
├─ electron.vite.config.mjs  electron-vite 配置(main/preload 外部化依赖)
├─ electron-builder.yml      打包配置(win: nsis+zip / mac: dmg+zip / linux: AppImage)
├─ .github/workflows/build.yml  CI:Windows 上构建+打包+上传产物
├─ README.md
├─ docs/
│  ├─ HANDOVER.md            本文件
│  └─ PLAN.md                进度与计划
└─ src/
   ├─ main/                  主进程(Node 环境)
   │  ├─ index.js            应用入口、窗口、全部 IPC handler、平铺网格计算
   │  ├─ store.js            profiles.json / settings.json 读写、路径定义
   │  ├─ launcher.js         命令行参数拼接、进程启停、运行态 Map、桥接集成
   │  ├─ fingerprint.js      随机指纹/种子生成、可选项(平台/品牌/地区表)
   │  ├─ proxyBridge.js      本地代理桥接(认证代理 / SOCKS5)
   │  └─ geo.js              按代理 IP 查询地理信息(时区/语言)
   ├─ preload/
   │  └─ index.js            contextBridge 暴露 window.api(渲染进程唯一入口)
   └─ renderer/              渲染进程(Vue)
      ├─ index.html
      └─ src/
         ├─ main.js          Vue 挂载
         ├─ style.css        全局暗色样式
         ├─ App.vue          主界面:列表/搜索/多选/批量/启停
         └─ components/
            ├─ ProfileEditor.vue  环境新建/编辑弹窗(指纹+代理+IP填充)
            └─ SettingsModal.vue  设置弹窗(内核路径/默认起始页)
```

## 4. 数据与文件位置

运行时数据存在 Electron 的 `userData` 目录(Windows:`%APPDATA%\fingerbrowser\`):

- `profiles.json` — 所有环境配置(数组)
- `settings.json` — 应用设置(`kernelPath`、`defaultStartupUrl`)
- `profiles/<环境id>/` — 每个环境独立的浏览器数据目录(Cookie/缓存/存储,物理隔离)

> 删除环境时**不会**删除其 `profiles/<id>/` 目录,避免误删登录态。需要清理时手动删。

## 5. 环境配置数据模型

`profiles.json` 中单个环境对象:

```jsonc
{
  "id": "uuid",
  "name": "Amazon-US-01",
  "group": "TikTok",
  "tags": ["美国", "主号"],
  "remark": "",
  "startupUrl": "https://browserleaks.com/canvas",
  "createdAt": 0, "updatedAt": 0,
  "fingerprint": {
    "seed": 123456789,          // 32 位整数,决定 Canvas/WebGL/音频/GPU 等
    "platform": "windows",      // windows | macos | linux
    "platformVersion": "10.0.0",
    "brand": "Chrome",          // Chrome | Edge | Opera | Vivaldi
    "brandVersion": "",
    "hardwareConcurrency": 8,
    "language": "en-US",        // --lang
    "acceptLanguages": "en-US,en", // --accept-lang
    "timezone": "America/New_York",
    "webrtcMode": "disable_non_proxied_udp" // disable_non_proxied_udp | off
  },
  "proxy": {
    "enabled": false,
    "type": "http",             // http | socks5
    "host": "", "port": "",
    "username": "", "password": ""
  }
}
```

## 6. 指纹参数 → 内核命令行映射

内核为 [fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium)(基于 ungoogled-chromium)。参数拼接见 `launcher.js` 的 `buildArgs()`:

| 配置项 | 命令行参数 |
|---|---|
| `fingerprint.seed` | `--fingerprint` |
| `platform` / `platformVersion` | `--fingerprint-platform` / `--fingerprint-platform-version` |
| `brand` / `brandVersion` | `--fingerprint-brand` / `--fingerprint-brand-version` |
| `hardwareConcurrency` | `--fingerprint-hardware-concurrency` |
| `timezone` | `--timezone` |
| `language` / `acceptLanguages` | `--lang` / `--accept-lang` |
| `webrtcMode != off` | `--disable-non-proxied-udp` |
| 代理 | `--proxy-server`(无认证直连;认证/SOCKS5 走本地桥接) |
| 环境隔离 | `--user-data-dir=<userData>/profiles/<id>` |
| 平铺 | `--window-position=x,y` / `--window-size=w,h` |
| 固定项 | `--no-first-run` `--no-default-browser-check` |

## 7. 代理桥接原理(重要)

内核的 `--proxy-server` **不支持账号密码认证**,部分内核对 SOCKS5 兼容也不佳。因此:

- `proxyBridge.js` 用 [`proxy-chain`](https://www.npmjs.com/package/proxy-chain) 在 `127.0.0.1` 起一个**匿名本地 HTTP 代理**,由它携带凭据转发到上游(HTTP 或 SOCKS5)。
- 浏览器只连 `http://127.0.0.1:<随机端口>`,凭据不进命令行、不外泄。
- 触发条件 `needsBridge()`:代理启用且(有用户名/密码,或类型是 SOCKS5)。无认证 HTTP 代理仍直连。
- 生命周期:随环境进程启动而起、随退出而关(`launch`/`stop`/`stopAll` 里已串好)。

`geo.js` 的"按代理 IP 填充"同理:临时经该代理请求 `ip-api.com`,拿到的就是**代理出口**的时区/国家,并按国家映射语言。

## 8. IPC API(渲染进程可用的 `window.api`)

定义在 `preload/index.js`,实现在 `main/index.js` 的 `registerIpc()`:

| 方法 | 说明 |
|---|---|
| `listProfiles()` | 读取全部环境 |
| `saveProfile(profile)` | 新建或更新(无 id 则新建) |
| `deleteProfile(id)` | 删除环境(不删数据目录) |
| `launchProfile(id)` | 启动单个环境 |
| `launchBatch(ids, tile)` | 批量启动;`tile=true` 平铺 |
| `stopProfile(id)` | 关闭环境 |
| `getRunning()` | 当前运行中的环境 id 列表 |
| `onRunningChanged(cb)` | 订阅运行态变化(返回取消函数) |
| `getSettings()` / `setSettings(s)` | 读写设置 |
| `randomFingerprint()` / `randomSeed()` | 生成随机指纹/种子 |
| `fingerprintOptions()` | 下拉可选项(平台/品牌/核心数/地区表) |
| `detectGeo(proxy)` | 按(代理)出口 IP 查地理信息 |
| `pickKernel()` | 弹系统文件框选内核 |

## 9. 本地开发与构建

> 团队约定:**本地只写代码,不装依赖;安装/构建/打包全部在 GitHub Actions 上做**(见第 10 节)。以下命令仅供需要本地跑时参考。

```bash
npm install        # 安装依赖(本地一般不做)
npm run dev        # 开发模式(热更新)
npm run build      # 构建 main/preload/renderer 到 out/
npm run dist       # 构建 + electron-builder 打包到 release/
```

- 首次使用应用:打开 → 设置 → 指定 fingerprint-chromium 的 `chrome.exe` 路径 → 新建环境 → 启动。
- 内核从 https://github.com/adryfish/fingerprint-chromium/releases 下载对应系统版本。

## 10. CI / 发布流程(GitHub Actions)

工作流 `.github/workflows/build.yml`:在 `windows-latest` 上 `npm ci || npm install` → `npm run build` → `npx electron-builder --win` → 上传 `fingerbrowser-windows` 产物(`.exe` + `.zip`)。

**私有仓库额度已用尽,所以约定"公开跑 CI、跑完转私有"**(公开仓库 Actions 免费):

```bash
# 推送前转公开
gh repo edit oarw/fingerbrowser --visibility public --accept-visibility-change-consequences
git push
# 监视运行(拿 run id:gh run list)
gh run watch <run_id> --exit-status
# 跑完转回私有
gh repo edit oarw/fingerbrowser --visibility private --accept-visibility-change-consequences
```

- 只改文档(`*.md`)不会触发 CI(工作流已配置 `paths-ignore`),这类推送无需转公开。
- 下载安装包:仓库 Actions 页 → 对应成功运行 → Artifacts → `fingerbrowser-windows`。

## 11. 已知限制与坑

- **内核不随包分发**:用户需自行下载 fingerprint-chromium 并在设置里指定路径。
- **GPU/WebGL 元数据伪装在 Windows 上受限**:内核 README 说明 WebGL 厂商/型号自定义目前主要面向 Linux,Windows 下 GPU 指纹可能有瑕疵(BrowserScan 可能标记)。
- **地理位置(经纬度)未注入**:目前只填时区/语言;若要伪装 `geolocation`,需通过 CDP 覆盖(阶段三)。
- **平铺仅在启动时生效**:窗口位置/大小由启动参数决定,启动后未做进程级窗口管理(那需要调用系统窗口 API)。
- **无自动化测试**:目前 CI 的"构建+打包成功"充当冒烟测试;尚无单测/端到端测试。
- **提交作者邮箱是占位符** `oarw@users.noreply.github.com`(未改动全局 git 配置)。如需真实邮箱请告知。
- 反检测强度参考:该内核 CreepJS 约 51.5%,可过 Cloudflare Turnstile;实际防关联仍强依赖**干净的独立代理 IP**。

## 12. 快速上手接手者清单

1. `gh auth status` 确认已登录有 repo/workflow 权限的账号。
2. 读 `launcher.js`(参数如何拼)、`proxyBridge.js`(代理如何转)、`App.vue`(界面如何驱动 IPC)——三个文件覆盖 80% 逻辑。
3. 改代码 → 转公开 → push → 看 CI 绿 → 转私有。
4. 需求排期见 `docs/PLAN.md`。
