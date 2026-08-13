# FingerBrowser

自研指纹浏览器管理器。基于**内核级指纹 Chromium**([fingerprint-chromium](https://github.com/adryfish/fingerprint-chromium),源自 ungoogled-chromium)做真正的指纹伪装,自身只负责多环境管理、隔离与启动,替代臃肿且有广告/限制的商业指纹浏览器。

## 架构

```
┌─────────────────────────────────────────┐
│  管理器 GUI (Electron + Vue 3)            │  ← 本仓库
│  · 环境增删改查 / 分组 / 标签 / 搜索       │
│  · 指纹参数可视化编辑 · 代理配置           │
│  · 一键启动 / 关闭                         │
├─────────────────────────────────────────┤
│  环境隔离层                               │
│  · 每环境独立 user-data-dir(物理隔离)     │
│  · 每环境独立代理出口                      │
├─────────────────────────────────────────┤
│  内核级指纹 Chromium(外部,单独下载)      │  ← 不在本仓库
│  · Canvas/WebGL/音频/字体/时区/GPU 伪装    │
│  · 命令行参数驱动(--fingerprint 等)       │
└─────────────────────────────────────────┘
```

指纹伪装发生在 C++ 内核层(而非 JS 注入),`.toString()` 返回 `[native code]`,可过 CreepJS / BrowserLeaks / Cloudflare Turnstile 等检测。

## 使用

1. 从 [fingerprint-chromium releases](https://github.com/adryfish/fingerprint-chromium/releases) 下载对应系统的内核并解压。
2. 打开本应用 → 设置 → 指定内核的 `chrome(.exe)` 路径。
3. 新建环境(可一键随机生成自洽指纹)→ 启动。

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

> 内核的 `--proxy-server` 暂不支持账号密码认证的代理,带认证代理将在后续版本通过本地桥接支持。

## 开发 / 构建

本项目的构建、打包全部在 GitHub Actions 上进行(见 `.github/workflows/build.yml`)。

本地开发(可选):

```bash
npm install
npm run dev      # 启动开发环境
npm run build    # 构建
npm run dist     # 构建 + electron-builder 打包
```

技术栈:Electron + Vue 3 + Vite(electron-vite)。当前支持 Windows,架构预留 macOS / Linux。

## 路线图

- [x] 阶段一 MVP:环境增删改查、独立隔离、指纹参数、一键启动
- [ ] 阶段二:SOCKS5/认证代理本地桥接、按代理 IP 自动填充时区语言、批量启动、窗口排列
- [ ] 阶段三:本地 API + CDP 自动化/RPA、代理订阅(Mihomo/Xray)、备份

## 许可

MIT
