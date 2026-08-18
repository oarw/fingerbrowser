# FingerBrowser

自研指纹浏览器环境管理器。基于**内核级指纹 Chromium**([fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium),源自 ungoogled-chromium)实现指纹伪装,自身负责内核下载校验、多环境管理、隔离与启动,替代臃肿且有广告/限制的商业指纹浏览器。

## 架构

```
┌─────────────────────────────────────────┐
│  管理器 GUI (Electron + Vue 3)            │  ← 本仓库
│  · 环境增删改查 / 分组 / 标签 / 备注 / 搜索 │
│  · 指纹参数可视化编辑 · 代理配置           │
│  · 一键启动 / 关闭                         │
├─────────────────────────────────────────┤
│  环境隔离层                               │
│  · 每环境独立 user-data-dir(物理隔离)     │
│  · 每环境独立代理出口                      │
├─────────────────────────────────────────┤
│  内核级指纹 Chromium(官方包,应用内下载)  │  ← 固定版本+SHA-256
│  · Canvas/WebGL/音频/字体/时区/GPU 伪装    │
│  · 命令行参数驱动(--fingerprint 等)       │
└─────────────────────────────────────────┘
```

指纹参数由 Chromium 内核层处理,不是在网页加载后临时注入 JS。它能减少常见注入痕迹,但不承诺通过所有检测站点;账号关联仍取决于代理出口、系统/时区/语言一致性、使用行为和内核版本等多层因素。

## 使用

1. 打开本应用 → `内核与设置` → `下载并安装`。应用支持断点续传,并在 SHA-256 校验通过后自动解压和启用官方 Windows x64 内核。
2. 也可以使用“手动内核”选择其他兼容的 `chrome.exe`。
3. 新建环境(可一键随机生成指纹),填写代理、标签和备注后启动。

> 内核二进制不打进 FingerBrowser 安装器,首次使用时由应用从固定的官方 GitHub Release 下载。当前固定版本为 `148.0.7778.215`,SHA-256 为 `9ef3f471b7a6641b4224532522b29141ce3746e27d55788d88e2fd951f362579`。

## 指纹参数(映射到内核命令行)

| UI 项 | 内核参数 |
|---|---|
| 指纹种子 | `--fingerprint` |
| 操作系统 / 版本 | `--fingerprint-platform` / `--fingerprint-platform-version` |
| 浏览器品牌 / 版本 | `--fingerprint-brand` / `--fingerprint-brand-version` |
| CPU 核心数 | `--fingerprint-hardware-concurrency` |
| 时区 | `--timezone` |
| 语言 / 接受语言 | `--lang` / `--accept-lang` |
| 代理 | `--proxy-server` |
| WebRTC 防泄漏 | `--disable-non-proxied-udp` |
| 环境隔离 | `--user-data-dir` |

> 带账号密码认证的代理或 SOCKS5 会自动经本地桥接(proxy-chain 在 127.0.0.1 起匿名代理携带凭据转发),浏览器只连本地端口。

## 开发 / 构建

本项目的单测、Electron 启动截图、构建和打包全部在 GitHub Actions 上进行(见 `.github/workflows/build.yml`)。推送 `v*` 标签由 `.github/workflows/release.yml` 自动校验上游内核并发布 Release。

本地开发(可选):

```bash
npm install
npm run dev      # 启动开发环境
npm run build    # 构建
npm run dist     # 构建 + electron-builder 打包
```

技术栈:Electron + Vue 3 + Vite(electron-vite)。当前仅构建 Windows x64;macOS / Linux 按现阶段范围暂缓。

## 路线图

- [x] 阶段一 MVP:环境增删改查、独立隔离、指纹参数、一键启动
- [x] 阶段二:SOCKS5/认证代理本地桥接、按代理 IP 自动填充时区语言、批量启动、窗口平铺
- [x] 阶段三:内核内置下载/校验、主界面工作台重构、备注快捷管理、品牌图标与启动过渡、CI 启动冒烟
- [ ] 暂缓:本地 API/CDP-RPA、代理订阅、云同步、自动更新、macOS/Linux

## 许可

MIT
