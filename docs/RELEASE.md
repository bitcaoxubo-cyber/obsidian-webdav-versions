# 0.4.0-beta.6 · NAS 无头同步端

NAS 现在可以作为第三台设备与 Mac、iPhone 同步。同步端在 Docker 中运行，将笔记和附件按原名存入 `vault/`，供 Muse 等外部工具通过飞牛 WebDAV 访问。每台设备保留自己的同步记录。[Docker 部署教程](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/blob/0.4.0-beta.6/docs/NAS无头同步端.md)

### Docker 镜像与配置

| NAS 处理器（`uname -m`） | 下载的发布附件 |
| --- | --- |
| Intel 或 AMD 64 位（`x86_64`） | `obsidian-webdav-headless-0.4.0-beta.6-linux-amd64.tar.gz` |
| ARM 64 位（`aarch64` 或 `arm64`） | `obsidian-webdav-headless-0.4.0-beta.6-linux-arm64.tar.gz` |

在有网络的设备上下载对应镜像、`compose.yaml`、`config.example.json` 和 `SHA256SUMS`，一起传到 NAS。按教程核对校验和后，用 `docker load -i <镜像归档文件名>` 离线导入。两种附件导入后的本地镜像名均为 `obsidian-webdav-headless:0.4.0-beta.6`。在独立的测试 WebDAV 目录初始化并确认双向同步后，再配置正式笔记库。[下载 beta.6](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/releases/tag/0.4.0-beta.6)

### NAS 端的同步保护

- 同步期间消失的文件和中断时尚在处理的删除，都要经过本轮删除检查。远端已经收到删除但响应丢失时，只补本地完成记录。远端未收到且本地已放回文件时，撤销原来的待办删除。
- 删空笔记库或超出删除数量上限时暂停，核对状态中列出的路径后，可放回文件或按实际数量批准。同步端能识别自身执行的删除和冲突副本清理。
- 文件或文件夹的名字采用 Unicode 分解形式时，状态会保留原始路径并提示改为 NFC。文件名与账号有相同字串也能完整显示，密码和认证串继续隐藏。

### Mac 和 iPhone 插件

在 BRAT 中将 `bitcaoxubo-cyber/obsidian-webdav-versions` 的固定版本改为 `0.4.0-beta.6`。手动升级时，用附件 `main.js` 和 `manifest.json` 覆盖已有的同名文件，保留 `data.json`、`local-state/` 和笔记。首次安装也可使用 `obsidian-webdav-versions-0.4.0-beta.6.zip`。最低 Obsidian 版本为 1.11.4。beta.5 的空文件夹清理继续可用。[插件安装与升级](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/blob/0.4.0-beta.6/README.md#更新插件) · [beta.5 发行说明](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/releases/tag/0.4.0-beta.5)

### 验证范围

合并前的 Linux 自动化测试和 GitHub Actions 均通过 817 项测试，覆盖 Mac 与 iPhone 模拟设备的 60 组随机编辑、200 次同步中随机删除，以及进程被杀和响应丢失后的恢复。飞牛实际文件权限、Muse 写入方式及 iPhone 后台行为仍需在自己的测试库核对。[逐项验收报告](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/blob/0.4.0-beta.6/docs/NAS无头同步端-验收报告.md#补充任务六验收)
