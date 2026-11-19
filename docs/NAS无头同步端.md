# 在飞牛或 Linux NAS 上部署无头同步端

NAS 会以独立设备的身份，与 Mac、iPhone 的 Obsidian 插件共用原有 HTTPS WebDAV 版本目录。它把当前笔记写成 Markdown 和附件，供 Muse 等工具经飞牛 WebDAV 读写。容器主动连接版本库，无需映射网络端口。

| 位置 | 用途 | 谁可以访问 |
| --- | --- | --- |
| 宿主机数据目录下的 `vault/` | 可编辑的当前笔记 | Muse 专用 WebDAV 账号和同步容器 |
| 同一数据目录下的 `state/` | 实例身份、同步记录、恢复日志和删除批准 | 同步容器和 NAS 管理员 |
| 插件配置的 HTTPS WebDAV 目录 | 版本历史，含插件管理的 v1 或 v2 子目录 | 配置中填写的版本库同步账号 |

## 1. 下载并导入镜像

在飞牛上启用 Docker，通过 SSH 登录 NAS。普通 Linux 用户在 NAS 本机终端操作。以下使用 Bash、Docker Compose v2、`curl` 和 `sha256sum`。先备份已同步的笔记，选择能持久保存部署文件和数据的目录，再逐段执行。[0.4.0-beta.6 发布页](https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/releases/tag/0.4.0-beta.6)

```bash
docker info --format '{{.ServerVersion}}'
docker compose version
cd "/替换成你的NAS持久化目录" && mkdir -m 700 obsidian-sync && cd obsidian-sync
```

在新建的 `obsidian-sync` 目录下载本机架构对应的镜像。Intel 或 AMD 的 `x86_64` 选用 `amd64`，64 位 ARM 选用 `arm64`。校验镜像、Compose 和配置示例后，再将镜像导入本机 Docker。

```bash
(
  set -eu
  version=0.4.0-beta.6
  case "$(uname -m)" in
    x86_64) arch=amd64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo "该架构没有预构建镜像：$(uname -m)" >&2; exit 1 ;;
  esac
  asset="obsidian-webdav-headless-${version}-linux-${arch}.tar.gz"
  url="https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions/releases/download/$version"
  for file in SHA256SUMS compose.yaml config.example.json "$asset"; do
    curl -fL --retry 3 -o "$file" "$url/$file"
  done
  for file in compose.yaml config.example.json "$asset"; do
    awk -v f="$file" '$2 == f { print }' SHA256SUMS | sha256sum -c -
  done
  docker image load -i "$asset"
  docker image inspect --format '{{.Os}}/{{.Architecture}}' "obsidian-webdav-headless:$version"
)
```

三项校验均应显示 `OK`，最后一行应为 `linux/amd64` 或 `linux/arm64`。NAS 无法访问 GitHub 时，可在另一台电脑从发布页下载这四个文件，按 **NAS** 架构选择镜像，再传入部署目录，跳过上述下载循环并在 NAS 上校验、导入。Compose 使用已导入的版本标签。[Docker 镜像导入说明](https://docs.docker.com/reference/cli/docker/image/load/)

## 2. 准备数据目录和 WebDAV 账号

同步端以实际写文件的数字 UID/GID 运行。先用 Muse 账号在采用相同身份映射的飞牛 WebDAV 共享中新建一个临时文件，在 NAS 终端填写它对应的本地路径。第一个数字应为普通用户的 UID。若看到 `0`，请先调整 WebDAV 的身份映射，再重新取值。随后可通过 WebDAV 移走该临时文件。

```bash
probe="/替换成探测文件的本地绝对路径"
stat -c '%u:%g %a %n' "$probe"
sync_uid=$(stat -c %u "$probe")
sync_gid=$(stat -c %g "$probe")
```

在部署目录旁新建 `obsidian-sync-data/`。下列命令使用管理员的 `sudo` 建目录和设置所有者，容器使用上一步的普通用户身份。如果已有同名数据目录，请先核对其中的笔记和状态；已部署的实例按第 6 节升级。

```bash
(
  set -eu
  test "$sync_uid" -gt 0
  sudo mkdir -m 700 ../obsidian-sync-data
  sudo install -d -m 700 -o "$sync_uid" -g "$sync_gid" ../obsidian-sync-data/{vault,state}
  sudo chown "$sync_uid:$sync_gid" ../obsidian-sync-data
)
```

在飞牛中把 `obsidian-sync-data/vault/` 单独授权给 Muse 的 WebDAV 账号。检查该账号和所属组可读写这个子目录，访问不到上级共享、`state/`、部署目录及版本存储。容器将整个 `obsidian-sync-data/` 挂载一次到 `/data`，以便在两个子目录之间创建硬链接和重命名。首次接入使用空的 `vault/` 和 `state/`，原有笔记会从版本库下载。

## 3. 写入配置和密码

将示例复制为工作配置，用编辑器填写 `url` 和 `username`。

```bash
umask 077
cp config.example.json config.json
vi config.json
```

| 字段 | 填写方法 |
| --- | --- |
| `url` | 原样填写 Mac 或 iPhone 插件中的 HTTPS WebDAV 文件夹地址。插件会自行选择版本子目录。 |
| `username` | 填写同一插件使用的版本库存取账号。 |
| `passwordFile` | 保留 `/run/secrets/webdav-password`，容器会从此处读取密码。 |
| `device`、`dataDir` | 示例使用设备名 `NAS` 和数据挂载点 `/data`。 |
| `intervalSeconds`、`settleSeconds` | 默认每轮结束后等 30 秒再开始下一轮，两次稳定扫描相隔 5 秒。 |
| `deletionLimit`、`allowInsecureLoopback` | 保留默认值 `20` 和 `false`。 |

在密码提示中输入版本库账号密码，屏幕不回显，密码不会进入命令历史。文件只授予同步 UID 读写。`.env` 中的绑定源按本部署目录定位，配置和密码以只读方式挂入容器。

```bash
(
  set -eu
  umask 077
  test "$sync_uid" -gt 0
  IFS= read -r -s -p '版本库 WebDAV 密码：' dav_password </dev/tty
  echo
  test -n "$dav_password"
  printf '%s\n' "$dav_password" > webdav-password
  unset dav_password
  chmod 600 config.json webdav-password
  sudo chown "$sync_uid:$sync_gid" config.json webdav-password
  cat > .env <<EOF
NAS_SYNC_UID=$sync_uid
NAS_SYNC_GID=$sync_gid
NAS_SYNC_DATA=../obsidian-sync-data
NAS_SYNC_CONFIG=./config.json
NAS_SYNC_PASSWORD_FILE=./webdav-password
EOF
  docker compose config --quiet
)
```

以后重新登录 NAS，先进入这个部署目录，再运行文中的 `docker compose` 命令。若数据目录选在其他存储卷，把 `.env` 中的 `NAS_SYNC_DATA` 改成该目录的绝对路径。使用私有 CA 时，将 CA 的 PEM 文件只读挂入容器，给 Compose 的 `environment` 加入 `NODE_EXTRA_CA_CERTS` 指向其容器内路径，再创建容器。

## 4. 初始化、首次下载与验收

首次安装运行一次 `init`，检查挂载、权限与文件系统，然后开始首轮同步。

```bash
docker compose run --rm sync init && docker compose run --rm sync run --once
docker compose run --rm sync status
```

`init` 会在 `state/` 创建实例身份。`run --once` 成功退出码为 0，暂停为 2，出错为 1。遇到暂停或错误，按第 5 节处理后再执行 `run --once`。确认状态为“正常”、上次成功时间已更新，并在 `vault/` 看见预期笔记后再启动常驻服务。

```bash
docker compose up -d sync
docker compose ps
docker compose exec sync node headless/cli.js status
docker compose logs --tail 100 sync
```

用 Muse 新建一篇测试笔记，等 `vault/.sync-status.json` 的 `lastSuccess` 晚于写入时间，再在 Mac 或 iPhone 前台同步，核对同名笔记与正文。从 Mac 修改它，再用 Muse 检查下载和写入权限。正常后再批量编辑笔记。

- `state/status.json` 保存私有状态，`vault/.sync-status.json` 是给 Muse 读取的镜像。两者显示中文原因、时间、传输计数、冲突及待批准删除的路径。NAS 的 `ok` 表示本轮已完成，其他设备各自轮询接收。
- `docker compose exec sync node headless/cli.js status --check` 静默返回退出码。状态为 `ok` 且距上次成功不超过 10 分钟时返回 0。健康检查和普通 `status` 详情可分别用于监控和诊断。
- 日志记录有变化的传输、暂停、错误和恢复，空闲轮不刷屏。按默认设置，网络或引擎错误会在 30、60、120、240、300 秒后重试，成功后恢复正常间隔。

## 5. 暂停、错误与确认

| 状态或原因 | 处理办法 |
| --- | --- |
| 两次扫描不同、文件夹仍在变化 | 等 Muse 完成本批操作；停止持续写入后会自动恢复。连续 10 分钟不稳定会提示“文件夹一直在变化”。 |
| 检查之后又有文件消失 | 该轮已中止。核对外部工具的删除操作，误删时把文件放回原路径。下一轮会按正常间隔重新检查并统计仍然消失的文件。 |
| 同步中的旧文件已全部消失，当前仅有新下载的文件 | 新笔记落盘前后，最后一篇旧笔记也消失了。请核对列出的旧文件，误删时放回，确实要删时按数量批准。 |
| 消失文件超过数量上限，或原来有文件、现在全空 | 先核对是否误删或挂载异常。把文件放回后自动恢复；确实要删时按下一段批准。 |
| `vault/` 不存在、被移走或不可读 | 恢复原挂载和权限；不要在错误位置新建空目录或重复 `init`。确认恢复原库后等下一轮。 |
| 文件名不安全或存在大小写/Unicode 重名 | 根据状态中最多 20 条路径与原因，由用户或 Muse 改名，再等下一轮；同步端不会替你改名。见[外部编辑约定](外部编辑约定.md)。 |
| 名字不是规范合成形式 | 按原因中列出的路径，把文件或文件夹重新命名为 Unicode 规范合成形式（NFC）。若工具将两种拼写视为同名，可先改为临时名称，再改成 NFC 名称。改完后同步会自动恢复。 |
| 网络、认证、证书或远端校验错误 | 检查连接与配置，保留现场；修复后自动重试。不要删本机状态或改版本目录来“修复”。 |
| 同一个状态目录已有运行实例 | 只保留一个实例。正常崩溃后重启应自动恢复，不需手工删锁。 |
| 跨挂载硬链接或重命名验证失败 | 改成一个数据挂载，确认文件系统支持操作；不要跳过验证。 |
| 冲突或 `needsAttention` 非零 | 到 Mac 或手机插件的确认窗口处理，再同步；无头端不解决冲突、不批准待确认项目，也不迁移存储布局。 |

文件名禁止 `\ * " < > : | ?`、末尾点或空格、只有大小写或 Unicode 组合形式不同的重名。点开头的条目不参与同步。不要自行创建含 `(sync-conflict` 的名称；引擎真正生成的冲突副本形如 `笔记名 (sync-conflict 设备名 版本号).md`，识别标记是带前导空格、且 `sync-conflict` 后也有空格的 ` (sync-conflict `。不能把任意含相似字样的文件都当成“不会上传”：例如缺少这些空格的名称不一定被引擎识别为冲突副本。即使另一个设备能保存冒号、问号，NAS 明文库也会拦下，需先改名。

### 确实要传播一批删除

先看 `pendingDeletions.count`，再核对每个路径及备份。`pendingDeletions.paths` 显示前 20 个，超过 20 个时可在 `pendingDeletions.allPaths` 或 `status` 命令输出查看完整列表。默认正好删除 20 个不拦截；删除 21 个会拦截；只有 3 篇却全删掉也会拦截。移动使用 WebDAV `MOVE`，若大小和修改时间保留，新旧路径可一对一抵消消失数量。

从 NAS 终端对正在运行的实例批准，`N` 必须换成当前实际消失数量：

```sh
docker compose exec sync node headless/cli.js approve-deletions --count N
```

下一轮会重新检查并应用有效批准。若容器已经停止，也可用 `docker compose run --rm sync approve-deletions --count N`，随后 `docker compose up -d sync`。

数量不符会拒绝。批准只绑定当时那组路径，只能使用一次；批准后多删一个、少删一个或换成另一组路径都会作废。批准在调用引擎前消耗，即使随后遇到网络或引擎错误也不会保留到重试，需重新核对并批准。检查时发现文件仍不稳定、文件名错误、目录缺失或不可读，也会保守作废已有批准，先解决原因再批准。

批准不是关闭删除保护。目录不可读或缺失不能靠批准绕过。不要在 `vault/` 放“批准文件”，Muse 无权批准自己造成的删除。

其他设备已确认并同步来的删除会先作用于 `vault/`，然后保存新清单，不会在下一轮被重复当成本地误删。

## 6. 升级

1. 暂停 Muse 写入，在原部署目录运行 `docker compose exec sync node headless/cli.js status`，核对未处理项目。
2. 运行 `docker compose stop sync`，备份整个数据目录（包括配套的 `vault/` 和 `state/`）、`.env`、配置、密码和当前的 `compose.yaml`。
3. 在新的临时目录按第 1 节下载目标版本的附件，将命令里的 `version` 换成该 Release 的标签。校验并导入镜像后，用校验过的新版 `compose.yaml` 替换原部署目录中的同名文件。保留原部署目录、`.env`、`config.json` 和密码文件，对照新版本配置示例补充必要设置。若上一版从源码目录或其他 Compose 工程运行，请先在那里停止原实例。
4. 返回原部署目录，执行下列命令。升级沿用已有的实例身份，只在首次安装时执行 `init`。

```bash
docker compose config --quiet && docker compose run --rm sync run --once
docker compose run --rm sync status
```

确认状态和笔记后运行 `docker compose up -d sync`，再恢复 Muse 写入。容器停止时会给当前轮次最多 8 秒，Compose 配置留出 10 秒；中断的操作会在下一次运行时从日志恢复。

### 可选：从发布标签自行构建

需要自行构建的同架构 Linux 主机可从发布标签生成同名镜像。从工作目录执行下列命令，构建后回到部署目录，使用同一份 `compose.yaml`。也可用 `docker image save` 将构建结果导出，传到 NAS 后用 `docker image load` 导入。

```bash
(
  set -eu
  version=0.4.0-beta.6
  git clone --depth 1 --branch "$version" https://github.com/bitcaoxubo-cyber/obsidian-webdav-versions.git
  cd obsidian-webdav-versions
  docker build -f headless/Dockerfile -t "obsidian-webdav-headless:$version" .
)
```

构建上下文是仓库根目录。镜像基于 `node:22-alpine`，复制 `src/` 和 `headless/` 后即可运行。

## 7. 同步记录丢失或损坏时恢复

1. 停止 Muse 写入，执行 `docker compose stop sync`，保留报错和当前现场。
2. 把整个 `vault/` 移到数据目录之外留作备份，确保 Muse 无法继续写它；不要只备份看起来“正常”的部分。
3. 备份旧 `state/`，将数据目录下的 `state/` 清空。可以把旧目录整体移到备份位置，再建立空目录，以保留诊断材料。
4. 重新建立空的 `vault/` 与 `state/`，恢复与容器 UID 相符的权限，核对单一数据挂载。
5. 重新执行 `init`，然后 `run --once`；等待原有远端的当前笔记全部下载并核对状态。
6. 对照备份，只把确实需要补回的新文件或未同步修改放回；同名文件先比较内容，不要整库覆盖。分批放回并观察同步结果。
7. 确认各设备内容后启动常驻服务，恢复 Muse 写入，暂时保留备份。

整个恢复过程不删除、不改写原有版本目录。若远端也报完整性错误，停在原处保留现场，不继续重新初始化来掩盖问题。

## 8. 卸载

停止 Muse 写入，执行 `docker compose down` 停止并移除容器。撤销 Muse 对 `vault/` 的 WebDAV 共享权限。备份后由用户决定是否保留 NAS 明文库、本机 `state/` 和配置；不要在容器仍运行时清空它们。卸载此无头端不需要操作其他设备的插件，也不操作原有版本目录。确认不再使用此版本后，可执行 `docker image rm obsidian-webdav-headless:0.4.0-beta.6` 回收镜像空间。

## 9. 已知限制和真机检查

稳定扫描降低半写入被发布的概率，但第二次扫描后、引擎读取前仍有空隙；若半篇漏过，通常下一轮会被完整内容取代，不能声称已根除。Muse 很久以前读到的内容若在新版本已到达 NAS 后写回，会被当作新修改，不一定生成冲突副本；写前重读、支持时使用 `If-Match`，并避免与其他设备同时操作。

无头端不提供自己的冲突界面、不处理待确认项、不取回历史版本。请把[外部编辑约定](外部编辑约定.md)交给 Muse。

两端在同步前各自修改同一篇时，外部工具的内容可保留在原路径或冲突副本中；原路径不固定属于哪一方。应结合 `conflicts` 检查两份正文，去 Mac 或手机插件里处理。此验收口径已获用户批准，见 [H9 修订说明](NAS无头同步端-H9修订.md)。

以下项目只能在用户授权的真实 NAS 与设备上验收；本次本机假 WebDAV 测试不能证明它们已通过：

- [ ] 通过 WebDAV 上传一个较大测试文件，观察 NAS 目录与文件大小变化，记录是原位写入还是临时文件后改名、临时名字是否以点开头。非隐藏临时文件可能进入同步范围。
- [ ] 双向做一次新建、读、改、删：Muse 能操作下载的测试笔记；容器能操作 Muse 创建的笔记及子目录。检查实际 UID/GID，确认没有权限错误。
- [ ] 使用 Muse 账号尝试访问 `state/`、数据目录上级和版本目录，均应被拒绝；同时 `vault/` 仍可正常读写。
- [ ] 用飞牛文件管理和 WebDAV 操作后检查目录，记录缩略图、回收站等系统条目名称。应不在同步范围，或以点开头；可见系统文件需评估，不能默认安全忽略。
- [ ] 对测试文件用正确和错误 ETag 分别做 `If-Match` 写入，确认过期条件被拒绝且内容不变；再用 `MOVE` 改名，比较移动前后的大小和修改时间。仅支持 `MOVE` 不代表一定保留时间。
- [ ] Muse 新建、修改、删除各一篇测试笔记，Mac 与前台 iPhone 同步后核对；再由 Mac/iPhone 反向执行并在 Muse 侧核对。
- [ ] 连续运行 24 小时，记录最终 `status`、日志行数及 `docker stats --no-stream` 的内存占用；应持续有近期成功记录、无无法解释的暂停/错误或持续内存增长。
