# HAI Bridge

2026-11-21 更新：0.5.0 新增[日常单命令启动](docs/daily-start.md)：Mac 记住配置后 publish-app；B 导入已有真实配对后 start 自动连接并启动一次 Codex，退出清理自有连接。沿用0.4.0的[最小真实接入](docs/real-hai.md)与隔离 mock。Windows 已收到mock21/21及0.4.0真实HAI流式调用5/5完整用户报告；新单命令封装、WSL、实际工具任务与长期恢复仍另行验证。Mac 管理策略已关闭 Remote Login，不再推进依赖系统登录的链路；无需云端部署我们的程序。以下旧系统 SSH CLI 保留为历史实现，不应为了使用它重新开启被策略关闭的功能。

让 B 上的 AI 工具经 SSH 访问 A 上已经认证的 HAI 代理。当前目标是 Mac A + Windows 11 原生 / WSL B，先验证 Codex 的完整请求与流式返回。

```text
B 本地工具 → B HTTP → 双向 TLS / ECS 出站 SSH 中转 → A TLS bridge → A:6655 HAI → 公司平台
```

HAI key 和公司登录凭证留在 A。B 的私有配对含独立桥接 token 与 B 短期 TLS 身份，不能上传 GitHub。运行需要 Node.js 22+，没有第三方 npm 依赖。

## 安装与版本

源码工作区运行 npm run pack 可生成本地 .tgz 包和 SHA-256，方便将同一份代码交付其他设备。没有发布到 npm；安装包不含 .local、mydocs、explore 或凭证。

~~~sh
npm install --global --offline --ignore-scripts --no-audit --no-fund ./hai-bridge-0.5.0.tgz
hai-bridge --version
hai-bridge dev --port 0
~~~

先核对可信来源的校验值再安装。Windows 可用 npm.cmd / hai-bridge.cmd，WSL 独立安装。现有 node bin/hai-bridge.mjs 在安装后可换成 hai-bridge；旧命令配置仍相对当前工作目录，新 start 默认使用个人 ~/.hai-bridge/client.json。详见 [安装说明](docs/installation.md)。

已有成功的真实 B 配对时，一次导入后每天在测试项目目录执行：

~~~powershell
hai-bridge.cmd setup-client --client-config 'D:\旧交付\.local\run-时间\client.json'
# 以下为日常使用；不要同时另开同端口 connect-app
hai-bridge.cmd start
~~~

start 保持 Codex 工作目录在 B 项目中，不改全局 Codex 配置；实际任务会计费。详细 Mac/Windows 步骤与一次集中检查见[日常启动](docs/daily-start.md)。

## 工作区

| 目录 | 用途 | Git |
| --- | --- | --- |
| `explore/` | 验证猜想的脚本、结果和历史资产 | 纳入 |
| `docs/` | 正式架构、使用和验证文档 | 纳入 |
| `mydocs/` | 开发过程笔记和临时文档 | 忽略 |
| `.local/` | 本机配置、配对文件和 token | 忽略 |
| `src/`、`bin/`、`test/` | MVP 实现、入口和测试 | 纳入 |

## 历史系统 SSH 实现（不继续部署）

以下至“纯本机开发”前的命令保留供历史查阅。当前请按[真实 HAI](docs/real-hai.md)或[应用 TLS mock](docs/application-cli.md)使用；不要开启 Mac Remote Login。

### 在 A 上启动（历史）

保持原来的 `hai proxy start` 运行。默认从当前用户的 `~/.codex/auth.json` 读取 `OPENAI_API_KEY`，不会导出其中的公司登录令牌。

```sh
node bin/hai-bridge.mjs init-server
node bin/hai-bridge.mjs pair --ssh-target user@mac-host
node bin/hai-bridge.mjs serve
```

将 `user@mac-host` 替换成 B 能通过 SSH 访问的 Mac 用户和地址，或 B 上的 SSH host 别名。将生成的 `.local/client.json` 通过获准的安全方式交给 B，放到 B 的项目目录中的同一路径。该文件包含桥接 token，应当保密。

Mac 需要已经启用远程登录，并配置 B 的 SSH 公钥。先在 B 手工执行一次 `ssh user@mac-host`，核对主机指纹并确认登录成功。工具保留 SSH 的主机密钥校验，使用 SSH agent / 公钥认证，不支持交互式密码重连。

## 在 B 上连接

Windows PowerShell 和 WSL 使用相同命令。先确认 `node --version` 和 `ssh -V` 可用，并将项目及配对文件放到 B 上。

终端一，保持隧道运行：

```sh
node bin/hai-bridge.mjs connect
```

终端二，先验证连接，再启动 Codex：

```sh
node bin/hai-bridge.mjs doctor
node bin/hai-bridge.mjs codex --
```

启动非交互任务：

```sh
node bin/hai-bridge.mjs codex -- exec "解释当前项目的结构"
```

Codex 需提前安装，当前验证版本为 0.163.0，启动器需要其支持 `--no-daemon`。启动入口通过进程参数设置桥接 provider，并将桥接 token 放入子进程环境变量 `HAI_BRIDGE_TOKEN`；运行时自动使用 `--no-daemon`，使凭证留在本次调用的进程环境中。现有 Codex 配置与认证文件不会被改写。

WSL 中使用 WSL 自己的 Node.js、SSH 和 Codex；直接在 WSL 中建立隧道即可，无需依赖 Windows / WSL 的 localhost 互通。如果两边同时运行，将其中一份 client 配置的 `local_port` 改成另一个端口，例如 16657。

同一局域网使用可到达的 Mac 地址。异地使用获准的网络、VPN 或已有 SSH 跳板配置；工具本身不提供公网打洞。

## ECS 中继封装

若已完成双层 SSH 的公钥与主机指纹准备，可以用新 CLI 替代手写 SSH：Mac `init-publisher` / `publish`，B `init-relay-client` / `connect`。两端保持前台，Ctrl-C 停止本命令拥有的 SSH；连接故障有有限重试，不重放模型请求。B 使用独立 SSH 配置和两个身份，不修改全局 SSH config。

当前先用 `--mock` 验证：B 18084→Mac 18080，内层 SSH 经 ECS 18083 终止于 Mac。真实 HAI 经个人 ECS 的具体授权尚未确认。新命令的本机测试及 Mac publisher 已通过，Windows/WSL 封装端到端与实际自动恢复仍待验证；旧手工 Windows 模拟链路的 11 PASS 不替代这轮验收。

完整初始化、启动和迁移说明见 [中继 CLI](docs/relay-cli.md)，下一轮集中验收及后续阶段见 [推进计划](docs/roadmap.md)。

0.2.0 增加 Windows/WSL 共用的 B 端批量生命周期入口。它自己启动测试内层 SSH，显式选 --interrupt-ssh 后只中断自有子进程并检查自动恢复，不需手工查 PID/重启；报告保存到新的 --out 文件。仅接受 --mock 配置，Mac publisher/历史模拟服务需预先运行。见 [集中检查](docs/lifecycle-checks.md)，不要同时另开同端口 connect。

## 纯本机开发

不需要 SSH 或 HAI 登录，一条命令启动实际 bridge 与模拟上游：

~~~sh
npm run dev
~~~

默认端口 18090；启动输出会提供临时配置及可复制的 doctor/probe 命令。Ctrl-C 关闭自有服务并清理临时配置；不会修改现有配对文件或历史实验。端口冲突可用 npm run dev -- --port 0。详见 [本机开发说明](docs/development.md)。

## 验证与更多说明

暂时不方便连接另一台设备时，可以先运行本机自检：

~~~sh
node bin/hai-bridge.mjs doctor --offline --client-config .local/relay-mock.json
node bin/hai-bridge.mjs doctor --offline --publisher-config .local/publisher.json
~~~

两条分别用于 B 和 Mac，不需要一起运行。加 --json 可输出结构化报告；不登录 SSH、不调用 HAI、不修改信任或读取私钥内容。它会短暂检查 B 本地端口绑定，端口已占用只显示警告。详见 [离线自检](docs/offline-checks.md)。

publish/connect 失败时提供 Next 排障提示；加 --json 可输出逐行安全状态事件。starting 只表示启动尝试，不表示就绪；实际连通仍以在线 doctor 为准。

```sh
npm test
node bin/hai-bridge.mjs probe
node bin/hai-bridge.mjs probe --infer
```

`probe` 只读取健康状态和模型列表；`probe --infer` 会发送一个极短的流式生成请求，默认使用 `gpt-6-luna`。连接真实上游时会计费；连接本机 `dev` 环境时返回合成输出，不产生模型费用。

- [架构与边界](docs/architecture.md)
- [配置与排障](docs/configuration.md)
- [验证记录](docs/validation.md)
- [最初的可行性探索](explore/2026-11-19-forwarding/README.md)

当前实现适用于本次已对齐范围内的 MVP 验证。逐用户身份认证、设备登记、图形界面和部署管理尚未实现；项目管理方式等待后续约定。
