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

1. 打开本应用 → `内核与设置` → `下载并安装`。托管内核默认安装到软件安装目录同级的持久数据目录（例如软件在 `D:\Programs\FingerBrowser`,内核位于 `D:\Programs\FingerBrowserData\kernels`）,仍跟随安装盘但不会被安装器升级覆盖;也可在设置页改为其他目录。旧版本若把内核放在程序目录内,首次启动会自动迁移到新目录。应用支持断点续传,并在 SHA-256 校验通过后自动解压和启用官方 Windows x64 内核。
2. 也可以使用“手动内核”选择其他兼容的 `chrome.exe`。
3. 新建环境(可一键随机生成指纹),填写代理、标签和备注后启动。代理默认按“系统代理/V2Ray → 指定出口代理”串联,也可关闭系统代理前置。
4. 在设置页开启“关闭窗口后保持后台运行”后,点击主窗口关闭按钮会缩到系统托盘;退出前如果仍有运行中的指纹环境,应用会先提示确认。

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

> HTTP、HTTPS、SOCKS5、认证代理和系统代理串联统一经本地桥接处理,浏览器只连接 127.0.0.1。出口检测会在多个免费 GeoIP 服务间自动回退并设置超时;“跳过代理证书认证”仅用于自签名代理证书,默认关闭。

> 代理类型必须按代理服务商提供的协议选择。HTTPS 表示客户端到代理服务器本身使用 TLS,并不等于“用于访问 HTTPS 网站”;端口 443 也不能单独证明它是 HTTPS 代理。出口检测失败时会优先显示上游 CONNECT、认证或证书阶段的诊断。

## 开发 / 构建

本项目的单测、Electron 启动截图、构建、打包和发版全部在 GitHub Actions 上进行(见 `.github/workflows/build.yml`)。每次 `main` 构建成功后会根据已有标签自动递增未占用版本，稳定版发布正式 Release，`-pre.N` 发布 Pre-release，并上传 Windows 安装包与 SHA-256 校验文件。推送 `v*` 标签仍可由 `.github/workflows/release.yml` 执行包含固定内核校验的正式发布流程。

本地工作区只做源码编辑和静态检查,不安装依赖、不执行测试或构建。单测、Electron 冒烟、构建、打包和发布均由 GitHub Actions 完成。

技术栈:Electron + Vue 3 + Vite(electron-vite)。当前仅构建 Windows x64;macOS / Linux 按现阶段范围暂缓。

## 路线图

- [x] 阶段一 MVP:环境增删改查、独立隔离、指纹参数、一键启动
- [x] 阶段二:SOCKS5/认证代理本地桥接、按代理 IP 自动填充时区语言、批量启动、窗口平铺
- [x] 阶段三:内核内置下载/校验、主界面工作台重构、备注快捷管理、品牌图标与启动过渡、CI 启动冒烟
- [x] 阶段四首批:profile manifest v1、出口 GeoIP 多源回退、IP 到时区/语言联动、启动前一致性检查、系统代理串联
- [ ] 暂缓:本地 API/CDP-RPA、代理订阅、云同步、自动更新、macOS/Linux

## 许可

MIT
