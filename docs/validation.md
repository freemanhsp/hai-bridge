# 验证记录

## 验证层次

1. `explore/2026-11-19-forwarding/` 保存最初的 HAI 行为探索。
2. `npm test` 用本机模拟上游验证桥接协议、认证隔离和异常行为，不调用真实模型。
3. `doctor` 验证桥接及配置上游的模型列表；模拟上游标记 `mock: true`、`hai: not_checked`，不证明真实 HAI 可用。
4. `probe --infer` 验证真实 Responses / SSE，发送一个极短的计费请求。
5. 在 Windows 原生与 WSL 各执行连接、诊断、流式生成和 Codex 任务，完成跨设备验证。

## 自动化覆盖

截至 2026-11-20，默认 `npm test` 共 49 项通过。原有 14 项覆盖错误 token 不访问 HAI、凭证替换与工具头保留、路径/方法限制、SSE 首块及时到达、取消传播、压缩字节保持、429 及重试提示保留、超时与凭证错误、1 MiB 请求体完整性、请求体大小限制、配对隔离与 key 轮换、配置限制、Codex 凭证不进入参数、SSH 安全参数和参数注入拒绝。

新封装增加 17 项：publisher/relay client 配置边界、独立双身份 profile 与本机 `ssh -G` 解析、不覆盖旧文件、显式模拟/配对模式、扩展 SSH 字段、离线 CLI、SSH 失败分类与退避预算、前台取消/子进程回收，以及模拟上游的明确诊断。重连和故障分类使用注入的模拟进程，不是跨设备网络实测。

这些检查针对真实代理边界和故障行为，使用临时 loopback 服务及临时目录，运行结束清理测试资源。

离线自检另增加 14 项，覆盖静态双层 profile、不读私钥/不改文件、配置与权限错误、复杂可执行规则拒绝展开、端口警告与释放、信任缺失/撤销/哈希/非默认端口、环境覆盖、Windows ACL 未检查提示及 CLI 输出/退出码。实际 Mac publisher 配置的离线检查为 pass；只证明本机准备项，不连接 ECS 或 HAI。Windows ACL 分支使用注入环境测试，不代表 Windows 实机已经通过。

## 初始探索结果

2026-11-19，Mac，Node.js 24.14.0，HAI 1.4.9：直接与中转模型列表均成功，错误 key 返回 401；直接与中转的 Responses 均返回 SSE 和 `response.completed`，两次生成合计 32 tokens。详情见历史资产。

## MVP 本机验证

2026-11-19，Mac，Node.js 24.14.0，HAI 1.4.9，Codex 0.163.0：

| 检查 | 结果 |
| --- | --- |
| 自动化集成检查 | 14 / 14 通过 |
| 桥接 token → HAI key → 模型列表 | 成功，14 个模型，默认模型可用 |
| MVP `probe --infer` | HTTP 200，SSE completed，2 个输出字符，11 input + 5 output tokens |
| 真实 Codex 经 MVP | provider 为 `hai-bridge`，返回 `OK`，进程退出 0 |
| 原生 Windows / WSL 跨设备 | 尚未实测 |

Codex 验证使用低推理、只读 sandbox、ephemeral 会话及 `gpt-6-luna`；Codex 报告 tokens used 为 10,556。短提示词仍包含代理自身的系统上下文，所以用量比裸 API 探针大。

初次 Codex 验证发现：全局位置的 `-c` 配置在本机版本的 `exec --ignore-user-config` 路径没有生效，导致回退到默认 provider，连接未成功并已停止。修正为把 overrides 放在 `exec` 子命令之后，随后 `--strict-config` 和真实生成均通过。此兼容问题已加入回归检查，详情见 [MVP 历史记录](../explore/2026-11-19-mvp/README.md)。

本机 `.local/client.json` 是单机测试配对文件，SSH target 为 A 的 loopback；用于 B 前必须改成 B 能到达的 Mac 地址或 SSH 别名。

## 尚待实际 B 验证

截至 2026-11-20，用户已报告 Windows→ECS 及经 ECS 的 Windows→Mac 免交互公钥认证成功；认证测试时 Mac 的组列表不含 `admin`。Windows 经该链路调用实际 bridge + 模拟上游的 models 和 SSE 也已提供成功输出并确认逐段到达；不代表真实 HAI 模型 API、Windows Codex 或 WSL 端到端通过。

- Windows 11 原生 npm Codex 入口与真实 AI 工具集成（OpenSSH 及模拟链路已验证）。
- WSL 独立 SSH、Node.js 和 Codex。
- Mac 远程登录与 B 公钥认证的长期稳定性、权限变化及撤销。
- 同局域网及异地获准网络路径。
- 休眠、断网后的有限重连与使用体验。
- 长时间、多工具调用、超大上下文、并发和真实 compaction。

本机测试结果不能标记为 Windows / WSL 跨设备已通过。

## 纯模拟 ECS 中继准备（2026-11-20）

为减少 Windows 手工切换，实验新增批量 PowerShell 脚本和固定下载接口：十项自动协议/并发/长流检查，可选一项交互式在途 SSH 中断与手动恢复。下载内容和 SHA-256 已本机核对，现有 14 项及实验 7 项测试通过。用户随后报告 Windows 批量脚本 11 PASS，且明确按提示中断并重新启动原来的 Windows 内层 SSH；据此记录批量检查及内层 SSH 手动恢复通过（用户报告，未提供完整新汇总日志）。此前独立实验 6 项结果属于新增下载接口前的记录。

[实验资产](../explore/2026-11-19-ecs-relay/README.md)复用实际 bridge，固定上游为临时 loopback 模拟服务，不读取真实认证或访问 HAI。原有 `npm test` 14 项与独立实验测试 6 项全部通过，`npm run check` 和实验脚本语法检查通过。6 项实验测试需按实验文档单独运行，未纳入默认 `npm test`。

Mac 本机冒烟测试确认健康检查、Unicode SSE、completed 事件及取消传播；取消后模拟上游 `activeStreams: 0`、`completedStreams: 1`、`cancelledStreams: 1`。Windows 已提供模型列表和 Unicode SSE completed 的完整输出，并确认逐段显示；Mac 随后实测 completed 计数增至 2、活动流归零。

Windows 取消长流后，模拟上游 cancelled 计数从 1 增至 2、active 归零；429/503 的状态码、错误体及 `Retry-After: 7` 均原样返回。用户的 requests 8 到助手复查的 11，正好包含两次错误 POST 和一次 models 查询，本轮没有观测到额外重放。后续批量测试补齐了上游 idle 超时、上游断线、四路并发、20 秒持续流，以及 Windows 内层 SSH 的在途中断、上游清理和手动恢复，当前模拟 MVP 的基础协议验证可以收尾。

仍未验证：Mac→ECS 外层故障恢复、自动重连、真实网络故障/休眠、WSL、真实 AI 客户端与真实 HAI 中继。测试服务和隧道是临时进程，11 PASS 不意味着常驻、完整权限收紧或真实 HAI 中继已获批准；当前无重放/恢复结论仅适用于本轮模拟场景。

## 新前台 CLI（2026-11-20）

新增 `init-publisher` / `publish`、`init-relay-client`，沿用 `connect`；使用独立配置、严格主机校验与有限连接重试，不重放模型请求。使用见 [中继 CLI](relay-cli.md)。

| 检查 | 结果与边界 |
| --- | --- |
| 默认本机自动化 | 31 / 31 通过，无真实模型请求 |
| 实验回归 | 独立 7 / 7 通过，按实验入口运行，未加入默认测试 |
| 新 Mac publisher 实际 SSH | 独立测试端口 18085 的 ECS 实际监听为 127.0.0.1；透过该端口取得的 SSH 主机指纹匹配 Mac |
| 新 Mac publisher Ctrl-C | 退出 0，18085 消失，旧 18083 隧道仍保留 |
| 新 Windows / WSL CLI | 尚未端到端实测；不能继承旧手工 Windows 11 PASS |
| 实际有限自动恢复 | 尚未验证内层、外层网络故障；本机测试只证明控制逻辑 |

此次 Mac 冒烟仅传输 SSH 元数据，无真实 HAI 或业务请求；没有接管原有隧道，也没有修改 VPN、安全组或 root 策略。下一轮重点是封装生命周期与恢复，基础模拟协议测试可以停止重复。

## 本机诊断与运行状态（2026-11-20）

先交付离线自检并在 45 项本机测试通过后单独提交；随后增加 4 项状态/提示测试，当前默认 49 / 49 通过。新增覆盖起停/等待事件顺序、失败/预算耗尽的安全原因与提示、等待中取消只停止一次，以及真实 CLI 的逐行 JSON 输出。CLI JSON 测试用临时本机 SSH stub，不连接远端；该 stub 测试仅适用于类 Unix，Windows 分支跳过，不能据此标记 Windows 实机通过。

实际 Mac 的既有 publisher 配置运行离线 doctor 为 pass，只查询本机文件元数据及已有主机记录；ECS 远端端口和实时指纹明确未检查。未启动新隧道、未修改信任/文件权限、未调用真实 HAI，也未替换旧运行中的测试进程。
