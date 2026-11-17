# NAS 无头同步端验收报告

日期：2026-11-16。基线：`bdb26b701e5be1693633145b062e30c62337f3db`（`main`，0.4.0-beta.5）。实施分支：`codex/nas-headless-sync`。

## 任务语义与交付范围

用户已批准将 H9 修订为“外部内容不丢失，可保留于原路径或冲突副本”，并要求保持引擎和协议不变。此前暂停条件已解除；原基线的主路径排序行为没有被改动。当前任务以 [任务说明](NAS无头同步端-任务说明.md) 和 [H9 修订说明](NAS无头同步端-H9修订.md) 为准，原始 12 次模型证据继续保留。

## 验证环境

本 PR 新增独立的 NAS 同步入口、三个同步前闸门、Docker 构建材料及中文操作约定。所有网络联调只访问本机回环地址的假 WebDAV；没有连接真实 NAS 或真实 WebDAV，没有发布插件或推送镜像。

本机使用 macOS、Node v24.22.1。大小写碰撞在临时的大小写敏感 APFS 卷实测。原始附录两个模型首次运行与示例输出一致，但重复运行证实 H9 不是固定结果（12 次中 6 次原路径变为 Mac 内容）；默认 Mac 卷不能同时存放 A.md/a.md，因此文件名模型另外在该大小写敏感卷运行，并复现预期失败。

最终 `npm run check`：**513/513 通过，0 失败、0 跳过**（414 个既有测试 + 99 个新增测试/子测试）。基线自身 `npm run check`：414/414；既有测试文件内容全部保持原样。本次完整命令为 `TMPDIR=<大小写敏感临时卷> npm run check`，耗时约 120 秒；[结果摘要](headless-evidence/check-summary.txt)已保存。源码改动仅 `src/local.js` 的第四个可选参数，`main.js` 已由构建脚本生成。

Docker 在本机不可用，H32 为**未验证**。飞牛 UID/ACL、WebDAV 实际写入语义及 Muse/Mac/iPhone 真机结果也均未验证，见末尾清单。此 PR 等待评审，不代表已部署到生产环境。

## H1–H32 逐项结果

| 编号 | 结果 | 证据（新增测试名中的 H 编号可直接定位） |
| --- | --- | --- |
| H1 | PASS | 最终 `npm run check`：**513/513 通过，0 失败、0 跳过**（414 个既有测试 + 99 个新增测试/子测试）；基线 414 个原测试逐文件比较无改动。 |
| H2 | PASS | `test/headless-local.test.js` 的两个 H2 测试；`git diff bdb26b7 -- src/` 仅 `local.js`，无参数路径与原路径一致。 |
| H3 | PASS | `node scripts/build.js` 后 `git diff --exit-code -- main.js`；`node scripts/package.js` 和 ZIP 成员检查，包内无 `headless/` 运行代码，bundle 不含该目录模块。 |
| H4 | PASS | `npm run bench` 前后原始输出见后文。六轮 HTTP 请求数与 vault 读文件数完全相同。 |
| H5 | PASS | integration `H5/H6/H10/H29`，真实磁盘外部新建/改写/删除，经假 DAV 由两个 MobileVault 设备收取；另有既有 v2 分片布局测试。 |
| H6 | PASS | 同上，v1 远端新增/改写/删除落到普通 Markdown；v2 另验证初次下载、Muse 新增/删除及远端改写，不迁移布局。 |
| H7 | PASS | integration `H7/H8`：两个内容均保留，存在冲突副本且 status.conflicts 列出逻辑路径。 |
| H8 | PASS | 同测试：远端删除与外部编辑并发，外部内容保留。 |
| H9 | PASS（用户批准修订） | integration 的两个 `H9 revised` 测试固定 nonce 分别构造 Mac/Muse 排在主路径的情况，验证两篇完整正文、标准冲突副本、远端版本和手机内容均保留；`CAS race, separate from H9` 另验证扫描后写入不被覆盖。 |
| H10 | PASS | integration 检查隐藏条目只有 `.sync-status.json`，无 `.obsidian`；版本对象中无状态镜像。 |
| H11 | PASS | integration 分别测试大小变化、新增、删除；不稳定轮零 DAV 请求，稳定轮只新增一个完整版本。gates 另测连续 10 分钟不稳定。 |
| H12 | PASS | integration `H12/H16`：21 个消失文件暂停、零 DAV 请求，另一设备仍持有全部笔记，状态含数量及最多 20 条路径。 |
| H13 | PASS | integration `H13`：正好 20 个消失文件正常同步。 |
| H14 | PASS | integration `H14/H15`：仅 3 篇全部删除也暂停。 |
| H15 | PASS | 同测试：vault 移走后暂停且不重建；gates 另测不可读目录。 |
| H16 | PASS | integration `H12/H16`：恢复原文件后自动恢复，无须批准。 |
| H17 | PASS | integration/gates：错误数量拒绝，正确数量放行，新增一条删除后旧批准作废；批准在引擎前消费，网络失败后不可复用。runtime 另测常驻端暂停期间 CLI 批准。 |
| H18 | PASS | integration `H18`：真实 rename 30 篇目录、保留 metadata，另一端路径全部变更，不暂停。gates 测每个新文件最多抵消一次。 |
| H19 | PASS | integration `H19`：远端删除 30 篇，NAS 应用后下一轮保持 ok；recovery 测删除完成但清单尚未提交时崩溃。 |
| H20 | PASS | integration/gates：驱动器前缀、尾点/尾空格、反斜杠、全部额外字符、大小写碰撞、Unicode/完整折叠碰撞；中文路径诊断、零引擎调用、字节不变、改名恢复。Unicode 等价碰撞用合成扫描验证；真实大小写碰撞用磁盘验证。 |
| H21 | PASS | integration `H21`：隐藏文件/目录、标准冲突副本、空目录不阻断普通笔记，空目录和冲突副本保留。相似标记的边界见“实现说明”。 |
| H22 | PASS | runtime `H22 H23` 及 CLI H22：无 instance.json 时拒绝并提示 init。 |
| H23 | PASS | runtime `H22 H23`：已有笔记及重复初始化均拒绝，原笔记字节不变。 |
| H24 | PASS | runtime H24：实际硬链接/rename；分别注入 EXDEV，拒绝并清理探测文件；启动时目录缺失、恢复后跨挂载也不能绕过验证。 |
| H25 | PASS | runtime H25：运行实例排他；SIGKILL 后自动接管；8 路并发竞争仅一个成功。 |
| H26 | PASS | recovery：远端已提交上传但响应未返回时强杀；最后一篇本地替换中途强杀；大批远端删除及保护清单提交窗口强杀；重启完成，无额外版本/内容丢失；另测旧 tombstone 不豁免新外部删除，以及损坏状态、收据、pending/checkpoint 在本地停止。 |
| H27 | PASS | runtime H27：真实子进程 SIGTERM，空闲等待立即结束；挂起 HTTP 的轮次约 8 秒强制退出，均小于 10 秒。 |
| H28 | PASS | runtime H28：注入时钟验证递增重试、5 分钟上限与成功重置；真实回环服务 503 后恢复，原笔记字节不变。 |
| H29 | PASS | runtime/integration 的特征密码检查：日志、状态、镜像、配置错误均无密码；另测用户名 ok/数字不破坏状态枚举与时间。 |
| H30 | PASS | runtime H30：非回环 HTTP、未知配置项、错误类型拒绝；无关闭 TLS 校验配置。 |
| H31 | PASS | runtime H31：单轮成功 0、暂停 2、错误 1；每次均释放运行锁，真实 CLI 也覆盖。 |
| H32 | **未验证** | 本机没有可用 Docker CLI/daemon，未执行镜像构建或 Compose 容器联调。仅检查 Dockerfile/Compose 的复制范围、单数据挂载、非 root UID/GID、只读配置和密码、健康检查入口。 |

## 实现说明与任务书的细化

- `DiskVault` 增加第四个可选对象 `{ privateDir }`，要求显式值为绝对路径。未传参数仍走原有 `.obsidian/plugins/obsidian-webdav-versions/local-state` 创建路径；原引擎、协议、DAV、移动端、插件和调度器均未改动。
- G2 本身不调用网络，也不修改笔记。为兑现 H26，在新一轮闸门前允许现有 `DiskVault.recover()` 完成上次已经记录的本地文件事务；这不是一次新的同步。只读既有状态/收据中的新增删除证据，用于避免崩溃前引擎已执行的删除被旧保护清单误拦。成功清单绑定相应检查点；历史 tombstone 之后仍被保留在成功清单中的文件，不因旧删除记录而永久豁免。损坏或缺失记录保守报错，不猜测修复。
- 删除批准绑定完整清单摘要及精确消失路径集合，在引擎调用前即消费。该轮网络出错也不自动重用；扫描不稳定、坏文件名会保守作废。这比任务书“用过一次作废”更保守，用户修复后重新批准即可。
- 原模型里的冲突副本使用引擎的精确标记 ` (sync-conflict `（含空格）。任务书“含 `(sync-conflict`”是简写；闸门按要求跳过这类名字的校验，但仅有相似字样的非标准名称仍可能被原引擎当作普通笔记上传。外部编辑约定禁止创建任何此类名称；不修改协议来扩大保留名范围。
- 单实例锁用共享 state 目录中的 Unix socket 和原子目录移交，避免依赖不同容器中可能重复的 PID。已退休 token 保留为小型私有目录，以避免并发回收误移新锁；正常重启不需人工清锁。
- 未新增 npm 依赖，未改 package.json、manifest.json 或 versions.json。Docker 材料不进入插件 bundle，发布 ZIP 额外包含面向用户的文档与 JSON/TXT 验收证据，不包含 headless 运行代码。

## 剩余风险

1. 按用户批准的 H9 语义，外部内容可保留在冲突副本；同步后的原路径正文可能是另一设备的版本。并发版本的主路径排序仍完全沿用原协议，需由用户在插件中处理冲突。
2. 稳定扫描仍有第二次扫描结束到引擎读取之间的空隙；一次持续很久但暂时停止的半写入也可能通过。后续完整内容通常会成为新版本，不能声称根除了半篇传播。
3. 外部工具读后久置、随后覆盖已经更新的笔记，仍可能被视为基于最新版本的普通编辑而无冲突副本。必须写前重读，服务端支持时使用 If-Match，并遵守约定。
4. 大小+mtime 的移动识别是任务书指定的启发式，不能证明两个文件内容相同。真机 MOVE 是否保留这些元数据尚未验证。
5. 崩溃恢复测试覆盖表中四个精确故障点，不能代表所有交错时序。静态复核发现一个尚未注入验证的保守边界：批量冲突副本删除若恰遇引擎状态已写入、收据已清理、保护清单尚未写入，旧清单可能触发删除暂停。这里缺少普通笔记 tombstone 的 absent 证据，不会自动扩大删除批准或丢弃内容；需核对状态后处理。
6. Docker、飞牛身份/ACL、共享隔离、WebDAV 原子写入及 iPhone 后台行为没有由本机测试替代；未通过真机清单前不应把本报告当成生产部署验收。

## 真机确认清单

以下均**未执行**，不属于本次 PR 本机通过条件：

- [ ] 用 Muse WebDAV 上传较大测试笔记，观察目标目录与文件大小变化；记录临时文件名字及是否点开头，明确是临时文件后改名还是原位写入。
- [ ] 记录 WebDAV 创建文件/目录的数值 UID:GID；容器以相同非 root 身份运行。Muse 能读改删同步下载的测试笔记，容器能读改删 Muse 新建笔记与目录，两个方向均无权限错误。
- [ ] 用 Muse 账号访问 vault 成功，访问 state、上级共享和版本目录均被拒绝；检查组权限和其他共享路径，不能只看一条 URL。
- [ ] 经飞牛文件管理/WebDAV 操作后检查缩略图、回收站等系统条目；应位于同步范围外或以点开头。可见系统条目需另行评估。
- [ ] 对测试文件分别发送匹配/过期 ETag 的 If-Match；过期请求应被拒绝且内容不变。用 MOVE 改名后比较大小与 mtime，验证是否保留。
- [ ] Muse 新建、修改、删除各一篇，Mac 和前台 iPhone 同步后核对；再从 Mac/iPhone 各做反向操作，Muse 侧核对。
- [ ] 连续运行 24 小时，记录 status、日志行数、`docker stats --no-stream` 内存。成功时间持续更新、无不明错误/暂停，空闲日志不刷屏，内存无持续增长。

## H4 基准原始输出

命令均为 `npm run bench`（1000 篇笔记、10 个 1 MiB 附件、v1）。耗时受调度与磁盘影响，不作为“完全相同”指标；请求数与读文件数比较一致。

| 场景 | HTTP 前/后 | vault readBinary 前/后 |
| --- | --- | --- |
| 初次上传 | 5059 / 5059 | 2020 / 2020 |
| 初次下载 | 3034 / 3034 | 1010 / 1010 |
| 空闲 | 2 / 2 | 0 / 0 |
| 编辑一篇 | 7 / 7 | 3 / 3 |
| 再次空闲 | 2 / 2 | 0 / 0 |
| 增量编辑 | 7 / 7 | 3 / 3 |

### 基线 bdb26b7

```text
vault: 1000 notes + 10 x 1 MiB attachments = 13.774 MiB, remote layout v1

== Mac initial upload (mobile code path) == up 1010 / down 0   wall 411 ms (node)
  adapter calls 40535 {"exists":8106,"stat":17222,"list":28,"readBinary":6066,"mkdir":5,"writeBinary":3037,"rename":3037,"remove":3034}
  local bytes read 57.217 MiB, written 16.023 MiB
  vault: {"list":22,"stat":3030,"readBinary":2020} read 27.548 MiB, written 0.000 MiB
  private: {"exists":8106,"stat":14192,"mkdir":5,"writeBinary":3037,"readBinary":4046,"rename":3037,"remove":3034,"list":6} read 29.668 MiB, written 16.023 MiB
  js sha256: 6060 calls, 0.973 MiB, max 170 bytes, 47 ms
  webcrypto sha256: 17188 calls, 157.578 MiB, max 1048576 bytes, 270 ms
  HTTP 5059 {"GET":2022,"PROPFIND":6,"MKCOL":1,"PUT":2020,"HEAD":1010} down 14.017 MiB up 14.016 MiB

== phone initial download == up 0 / down 1010   wall 339 ms (node)
  adapter calls 52731 {"exists":13180,"stat":22319,"mkdir":1036,"writeBinary":4048,"readBinary":5057,"rename":3038,"list":8,"copy":1010,"rmdir":1010,"remove":2025}
  local bytes read 29.994 MiB, written 16.348 MiB
  vault: {"list":1,"stat":6102,"mkdir":21,"exists":2041,"readBinary":1010} read 13.774 MiB, written 0.000 MiB
  private: {"exists":11139,"stat":16217,"mkdir":1015,"writeBinary":4048,"readBinary":4047,"rename":3038,"list":7,"copy":1010,"rmdir":1010,"remove":2025} read 16.220 MiB, written 16.348 MiB
  js sha256: 1010 calls, 0.162 MiB, max 170 bytes, 8 ms
  webcrypto sha256: 15171 calls, 103.342 MiB, max 1048576 bytes, 185 ms
  HTTP 3034 {"GET":2022,"PROPFIND":2,"HEAD":1010} down 14.512 MiB up 0.000 MiB

== phone IDLE sync (nothing changed anywhere) == up 0 / down 0   wall 31 ms (node)
  adapter calls 1043 {"exists":1,"stat":1016,"readBinary":2,"list":24}
  local bytes read 0.560 MiB, written 0.000 MiB
  vault: {"list":22,"stat":1010} read 0.000 MiB, written 0.000 MiB
  private: {"exists":1,"stat":6,"readBinary":2,"list":2} read 0.560 MiB, written 0.000 MiB
  js sha256: 0 calls, 0.000 MiB, max 0 bytes, 0 ms
  webcrypto sha256: 2 calls, 0.530 MiB, max 278667 bytes, 1 ms
  HTTP 2 {"PROPFIND":2} down 0.495 MiB up 0.000 MiB

== phone sync after editing ONE note == up 1 / down 0   wall 29 ms (node)
  adapter calls 1102 {"exists":14,"stat":1039,"readBinary":10,"list":24,"writeBinary":5,"rename":5,"remove":5}
  local bytes read 0.843 MiB, written 0.411 MiB
  vault: {"list":22,"stat":1013,"readBinary":3} read 0.000 MiB, written 0.000 MiB
  private: {"exists":14,"stat":26,"readBinary":7,"list":2,"writeBinary":5,"rename":5,"remove":5} read 0.843 MiB, written 0.411 MiB
  js sha256: 4 calls, 0.001 MiB, max 235 bytes, 0 ms
  webcrypto sha256: 23 calls, 1.361 MiB, max 295011 bytes, 1 ms
  HTTP 7 {"PROPFIND":2,"PUT":2,"HEAD":1,"GET":2} down 0.496 MiB up 0.000 MiB

== phone second IDLE sync == up 0 / down 0   wall 46 ms (node)
  adapter calls 1043 {"exists":1,"stat":1016,"readBinary":2,"list":24}
  local bytes read 0.563 MiB, written 0.000 MiB
  vault: {"list":22,"stat":1010} read 0.000 MiB, written 0.000 MiB
  private: {"exists":1,"stat":6,"readBinary":2,"list":2} read 0.563 MiB, written 0.000 MiB
  js sha256: 0 calls, 0.000 MiB, max 0 bytes, 0 ms
  webcrypto sha256: 2 calls, 0.532 MiB, max 278734 bytes, 0 ms
  HTTP 2 {"PROPFIND":2} down 0.496 MiB up 0.000 MiB

== phone incremental sync after editing ONE note == up 1 / down 0   wall 26 ms (node)
  adapter calls 71 {"exists":14,"stat":30,"readBinary":10,"list":2,"writeBinary":5,"rename":5,"remove":5}
  local bytes read 0.845 MiB, written 0.411 MiB
  vault: {"stat":4,"readBinary":3} read 0.000 MiB, written 0.000 MiB
  private: {"exists":14,"stat":26,"readBinary":7,"list":2,"writeBinary":5,"rename":5,"remove":5} read 0.845 MiB, written 0.411 MiB
  js sha256: 4 calls, 0.001 MiB, max 235 bytes, 0 ms
  webcrypto sha256: 23 calls, 1.363 MiB, max 295080 bytes, 1 ms
  HTTP 7 {"PROPFIND":2,"PUT":2,"HEAD":1,"GET":2} down 0.496 MiB up 0.000 MiB

state file sizes (bytes): [ 295011, 295080 ]
```

### 本 PR 最终实现

```text
vault: 1000 notes + 10 x 1 MiB attachments = 13.774 MiB, remote layout v1

== Mac initial upload (mobile code path) == up 1010 / down 0   wall 396 ms (node)
  adapter calls 40535 {"exists":8106,"stat":17222,"list":28,"readBinary":6066,"mkdir":5,"writeBinary":3037,"rename":3037,"remove":3034}
  local bytes read 57.217 MiB, written 16.023 MiB
  vault: {"list":22,"stat":3030,"readBinary":2020} read 27.548 MiB, written 0.000 MiB
  private: {"exists":8106,"stat":14192,"mkdir":5,"writeBinary":3037,"readBinary":4046,"rename":3037,"remove":3034,"list":6} read 29.668 MiB, written 16.023 MiB
  js sha256: 6060 calls, 0.973 MiB, max 170 bytes, 45 ms
  webcrypto sha256: 17188 calls, 157.578 MiB, max 1048576 bytes, 266 ms
  HTTP 5059 {"GET":2022,"PROPFIND":6,"MKCOL":1,"PUT":2020,"HEAD":1010} down 14.017 MiB up 14.016 MiB

== phone initial download == up 0 / down 1010   wall 334 ms (node)
  adapter calls 52731 {"exists":13180,"stat":22319,"mkdir":1036,"writeBinary":4048,"readBinary":5057,"rename":3038,"list":8,"copy":1010,"rmdir":1010,"remove":2025}
  local bytes read 29.994 MiB, written 16.348 MiB
  vault: {"list":1,"stat":6102,"mkdir":21,"exists":2041,"readBinary":1010} read 13.774 MiB, written 0.000 MiB
  private: {"exists":11139,"stat":16217,"mkdir":1015,"writeBinary":4048,"readBinary":4047,"rename":3038,"list":7,"copy":1010,"rmdir":1010,"remove":2025} read 16.220 MiB, written 16.348 MiB
  js sha256: 1010 calls, 0.162 MiB, max 170 bytes, 5 ms
  webcrypto sha256: 15171 calls, 103.342 MiB, max 1048576 bytes, 184 ms
  HTTP 3034 {"GET":2022,"PROPFIND":2,"HEAD":1010} down 14.512 MiB up 0.000 MiB

== phone IDLE sync (nothing changed anywhere) == up 0 / down 0   wall 32 ms (node)
  adapter calls 1043 {"exists":1,"stat":1016,"readBinary":2,"list":24}
  local bytes read 0.560 MiB, written 0.000 MiB
  vault: {"list":22,"stat":1010} read 0.000 MiB, written 0.000 MiB
  private: {"exists":1,"stat":6,"readBinary":2,"list":2} read 0.560 MiB, written 0.000 MiB
  js sha256: 0 calls, 0.000 MiB, max 0 bytes, 0 ms
  webcrypto sha256: 2 calls, 0.530 MiB, max 278667 bytes, 0 ms
  HTTP 2 {"PROPFIND":2} down 0.495 MiB up 0.000 MiB

== phone sync after editing ONE note == up 1 / down 0   wall 30 ms (node)
  adapter calls 1102 {"exists":14,"stat":1039,"readBinary":10,"list":24,"writeBinary":5,"rename":5,"remove":5}
  local bytes read 0.843 MiB, written 0.411 MiB
  vault: {"list":22,"stat":1013,"readBinary":3} read 0.000 MiB, written 0.000 MiB
  private: {"exists":14,"stat":26,"readBinary":7,"list":2,"writeBinary":5,"rename":5,"remove":5} read 0.843 MiB, written 0.411 MiB
  js sha256: 4 calls, 0.001 MiB, max 235 bytes, 0 ms
  webcrypto sha256: 23 calls, 1.361 MiB, max 295011 bytes, 1 ms
  HTTP 7 {"PROPFIND":2,"PUT":2,"HEAD":1,"GET":2} down 0.496 MiB up 0.000 MiB

== phone second IDLE sync == up 0 / down 0   wall 43 ms (node)
  adapter calls 1043 {"exists":1,"stat":1016,"readBinary":2,"list":24}
  local bytes read 0.563 MiB, written 0.000 MiB
  vault: {"list":22,"stat":1010} read 0.000 MiB, written 0.000 MiB
  private: {"exists":1,"stat":6,"readBinary":2,"list":2} read 0.563 MiB, written 0.000 MiB
  js sha256: 0 calls, 0.000 MiB, max 0 bytes, 0 ms
  webcrypto sha256: 2 calls, 0.532 MiB, max 278734 bytes, 0 ms
  HTTP 2 {"PROPFIND":2} down 0.496 MiB up 0.000 MiB

== phone incremental sync after editing ONE note == up 1 / down 0   wall 25 ms (node)
  adapter calls 71 {"exists":14,"stat":30,"readBinary":10,"list":2,"writeBinary":5,"rename":5,"remove":5}
  local bytes read 0.845 MiB, written 0.411 MiB
  vault: {"stat":4,"readBinary":3} read 0.000 MiB, written 0.000 MiB
  private: {"exists":14,"stat":26,"readBinary":7,"list":2,"writeBinary":5,"rename":5,"remove":5} read 0.845 MiB, written 0.411 MiB
  js sha256: 4 calls, 0.001 MiB, max 235 bytes, 0 ms
  webcrypto sha256: 23 calls, 1.363 MiB, max 295080 bytes, 1 ms
  HTTP 7 {"PROPFIND":2,"PUT":2,"HEAD":1,"GET":2} down 0.496 MiB up 0.000 MiB

state file sizes (bytes): [ 295011, 295080 ]
```
