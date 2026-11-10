# 0.2.0-beta.1：iPhone 本地库接入测试版

为现有飞牛 WebDAV 版本同步增加移动端运行路径。无需 iCloud；GitHub 用于插件分发，笔记仍通过飞牛 WebDAV 同步。

## 本次变化

- 移动路径不依赖 Node.js、Buffer、桌面文件路径或 Electron。
- SHA-256、UTF-8、Base64 和安全随机标识可在移动 WebView 运行，v1 修订 ID 与 0.1.1 固定样本一致。
- 通过 Obsidian DataAdapter 保存手机笔记、双槽状态快照、离线待上传内容和文件替换日志。
- 替换时先保存原文件，使用“目标已存在则失败”的 copy，遇到并发修改保留内容并延后或停止。
- 原生 requestUrl 执行 WebDAV；下载前检查长度，大附件优先按 4 MiB 分段并校验范围和完整内容。
- 手机上限 128 MiB，桌面仍为 512 MiB。前台恢复触发同步，设置页与命令面板可查看状态。
- 兼容旧 Mac 0.1.1 的远端格式；本次交付不替换已安装的 Mac 插件，也不迁移正式远端。

## 自动化验证

执行 `node scripts/build.js && node --test test/*.test.js`。覆盖原有桌面回归、移动端并发冲突、重启恢复、暂存重试、编码及哈希交叉核验、大附件 Range、状态损坏停止，以及无 Node/Buffer 的构建产物加载与同步。

模拟 API 验证的是公开 API 合约与本插件逻辑，不是 iOS 文件系统、原生网络或真实飞牛端点的实测。

## 发布边界

**本版本未完成 iPhone 真机验收，按 prerelease 发布。先使用独立测试库，通过 docs/iPhone安装与验收.md 后再连接正式库。**

- iOS 原生文件写入、目录刷新、编辑器行为、后台挂起、SecretStorage、TLS、HEAD / Range 和大附件内存表现均待真机确认。
- 原生 requestUrl 不提供流式响应或禁止重定向的公开开关。仅使用可信且不跳转的最终 HTTPS 地址。若服务器忽略 Range，会接收一次完整响应；单文件仍需载入内存。
- 128 MiB 上限不是对所有 iPhone 的性能保证。未提供选择性同步或按需附件占位，超过上限时暂停，不删除远端内容。
- 本地日志使用移动文件 API 和读回校验；不声称具有桌面 fsync / 硬链接的底层语义或设备断电保证。
- 本版本无端到端加密、远端历史清理或锁屏持续同步。

## 安装

在 iPhone 创建不存入 iCloud 的本地空白测试库，安装 BRAT，添加 `bitcaoxubo-cyber/obsidian-webdav-versions` 并固定 `0.2.0-beta.1`。无需 GitHub Token。

Release 附件 `manifest.json` 与 `main.js` 可由 BRAT 直接安装。ZIP 用于手工安装或留存，SHA256SUMS 用于核验。
