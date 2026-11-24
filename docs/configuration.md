# 配置与排障

0.5.1保留v1/app-tls，新增独立schema2/app-device；v2配置/身份流程见[个人设备认证](device-auth.md)，不能手改旧JSON完成迁移。本页先说明v1配置边界；后半保留原有SSH MVP，不按旧排障步骤重新开启被管理策略关闭的Mac Remote Login。真实使用见[日常启动](daily-start.md)、[应用排障](troubleshooting.md)与[凭据说明](credentials.md)。

## v1应用配置（0.5.0引入，0.5.1保留）

server.json / client.json 都有schema_version=1、transport=app-tls、mode=mock或hai、role=publisher或client。字段/角色/配对不符拒绝；不要给旧SSH JSON添加transport就当作迁移。

共同配置为ssh_target（非root ECS账号）、ssh_port、identity_file、known_hosts_file、relay_port、reconnect/max_retries与tls_dir。publisher另有app_port，真实publisher明确指定loopback upstream_url/upstream_auth_file；client另有local_port/tunnel_port，不能存A的上游认证。A/B必须使用同一中继端口与匹配私有身份；SSH信任先通过可信渠道核对。

相对身份/信任/TLS路径按配置文件目录解析；setup-publisher只记录A绝对配置路径，setup-client复制B配对到个人目录而保留SSH绝对路径。默认已存在则拒绝覆盖，程序升级不续期、不改信任或启动进程。

真实app-tls不接受HAI_UPSTREAM_API_KEY/HAI_BRIDGE_TOKEN作为认证来源覆盖，不支持--base-url覆盖或旧doctor --offline。0.5.1的start/haib优先读取use-client保存的client-default.json指针，没有指针才用个人client.json；指针损坏拒绝回退。use-client仅记原真实配置路径，不复制身份。手动connect-app/doctor须显式指向配置，不假定它们也使用个人默认项。v1应用离线诊断使用[inspect-app](application-inspection.md)，v2离线诊断待开发。

## 以下是历史系统SSH配置

下面的环境覆盖、多provider可选项、16656端口和Mac SSH22发布只属于旧实现，不代表当前真实app-tls开放这些能力。

## Mac 配置

`init-server` 生成 `.local/server.json` 和 `.local/bridge.token`。初始化和配对均拒绝覆盖已有文件。需要改变设置时编辑生成的 JSON，或选择新的输出路径。

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `listen_host` | `127.0.0.1` | 桥接只支持 loopback 监听 |
| `listen_port` | `16656` | A 上桥接端口 |
| `upstream_url` | `http://127.0.0.1:6655` | 固定的本地 HAI origin |
| `upstream_auth_file` | 当前用户的 `.codex/auth.json` | 读取 HAI `OPENAI_API_KEY` |
| `bridge_token_file` | `bridge.token` | 相对于 server 配置文件解析 |
| `idle_timeout_ms` | `120000` | 上游无活动超时，不是整段生成的总时限 |
| `max_request_bytes` | `67108864` | 请求体上限，64 MiB |
| `allowed_providers` | `["openai"]` | 允许的模型 provider |

用其他认证文件初始化：

```sh
node bin/hai-bridge.mjs init-server --upstream-auth-file /path/to/auth.json
```

环境变量 `HAI_UPSTREAM_API_KEY` 可覆盖 A 的 HAI key 来源；`HAI_BRIDGE_TOKEN` 可覆盖桥接 token。不要把真实凭证写入命令行参数、正式文档或 Git。

## B 配置

`.local/client.json` 包含桥接 token、SSH target、两端转发端口、模型和有限重连配置。私钥内容不会由本工具读取或传输。

| 可选 SSH 字段 | 含义 |
| --- | --- |
| `identity_file` | 本机私钥路径，配合 `IdentitiesOnly=yes` 使用 |
| `ssh_config_file` | 独立 SSH profile，传给 SSH 的 `-F` |
| `known_hosts_file` | 已核对的主机信任文件；设置后不读取全局 known_hosts |
| `ssh_host_key_alias` | 主机密钥校验别名，如 `hai-bridge-mac` |
| `ssh_port` | SSH 目标入口端口，非模型 HTTP 端口 |

路径支持 `~/`，相对路径以 client 配置所在目录解析。无 `ssh_config_file` 的旧直连 client 仍读取已有 SSH aliases。ECS 模式由 [中继初始化命令](relay-cli.md)生成独立 profile，分别设置跳板与 Mac 的密钥、端口及信任；只有一个顶层 `identity_file` 不能代替两个身份。

`max_retries` 初始化为 5，连接故障的重连等待为 1、2、4、8、15 秒；SSH 进程存活 30 秒后重置连续失败预算，不代表 HTTP 健康。SSH 退出被分类为认证、主机指纹、配置或转发错误时停止；用普通 SSH 命令先排障，不要关闭主机指纹校验。Ctrl-C 主动退出不重连，连接恢复不重放模型请求。

不同 SSH 端口、VPN 路径或跳板机通过用户已有的 SSH config 配置，以 host 别名作为 `ssh_target`。

## Mac publisher 配置

`init-publisher` 生成 `.local/publisher.json`，与 server/client 配置独立：`ssh_target` 必须是非 root 的 `user@host`，`ssh_port` 默认为 22，`relay_port` 默认为 ECS loopback 18083；`reconnect` 为 true，`max_retries` 为 5。可选 SSH 字段及路径解析规则同上。

`publish` 只允许 ECS loopback→Mac loopback SSH 22，不能发布 HAI HTTP 6655。未指定独立 profile 时使用空 SSH config，避免继承全局额外转发；公钥/agent 和已核对的 known_hosts 仍需提前准备。初始化文件在 Unix 上以 0600 创建，Windows 还应确认目录/文件 ACL 仅允许预期用户访问。

## AI 工具入口

dev 生成的 client 使用 local_only=true，connect 会拒绝这类配置，doctor/probe 可直接请求本机模拟服务；它不是跨设备配对。该可选字段必须为 boolean，不设置时维持原有 SSH 行为。详见 [本机开发](development.md)。

Windows 原生 Codex 启动入口先查找 `codex.exe` 或 npm 的 `@openai/codex/bin/codex.js`，不通过 `.cmd` 拼接命令。如果安装路径特殊，设置 `HAI_CODEX_EXECUTABLE` 为原生可执行文件或该 JS 入口的绝对路径。

启动器自动加入 `--no-daemon`，避免已有共享 daemon 使用其他会话的环境。已验证 Codex 0.163.0；若旧版本不支持此参数，请升级后使用本入口。exec 的 provider 覆盖参数放在子命令之后，以确保在 `--ignore-user-config` 等模式下仍然生效。

## Mac 上单机验证

在 A 上运行桥接后，可用同一配对文件直接验证桥接，无需启动 SSH：

```sh
node bin/hai-bridge.mjs doctor --base-url http://127.0.0.1:16656
node bin/hai-bridge.mjs probe --base-url http://127.0.0.1:16656 --infer
```

这只验证 A 上的桥接到 HAI 链路，不代替 B 的跨设备验证。

## 排障

可以先用 doctor --offline 检查本机配置、SSH 身份路径、简单独立 profile 与信任记录；不会连接 ECS/HAI 或修复配置。具体范围、警告及退出码见 [离线自检](offline-checks.md)。

publish/connect 的默认日志会附带 Next 排障建议；加 --json 输出逐行安全状态事件，见 [中继 CLI](relay-cli.md)。事件描述的是进程/重试状态，不表示 SSH 或 HAI 已就绪。

| 现象 | 检查 |
| --- | --- |
| `connect` 退出 | SSH 是否可达、公钥是否授权、主机指纹是否核对、端口是否占用 |
| `doctor` 无法连接 | `serve`、`connect` 是否仍运行，client 端口是否匹配 |
| `bridge_unauthorized` / 401 | B 配对 token 是否与 A 相同，是否被环境变量覆盖 |
| HAI 模型列表返回 401 | A 的 HAI key 是否正确，HAI 是否需要重新登录 |
| `bridge_credentials_unavailable` / 503 | A 的认证文件或 token 文件是否可读 |
| `upstream_unavailable` / 502 | HAI 是否仍在指定本机端口运行 |
| `upstream_timeout` / 504 | HAI 或上游是否长时间无响应，是否需要调整 idle timeout |
| 429 | HAI / 模型平台额度或容量限制，桥接不会自动重试 |
| Windows 与 WSL 端口冲突 | 两边使用不同 `local_port`，分别建立 SSH 隧道 |

桥接恢复并不能解除 HAI 的额度、模型、工具或登录限制。Mac 休眠、断网或 HAI 停止会中断正在进行的请求。
