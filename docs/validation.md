# 验证记录

## 最小真实 HAI 应用接入 0.4.0（2026-11-20）

用户明确确认可尝试个人 Windows → 个人 ECS → 公司 Mac HAI 的既有路径。本轮新增隔离 --hai 配对/随机 token、固定 A loopback 上游及逐请求认证读取、B try-hai 与 Windows 私有一次试用包；check-app 和原 mock 交付仍只接受 mock。无 VPN/MDM/系统登录/云端权限修改，不导出 HAI key。

用户随后提交 [Windows 真实调用完整报告](../explore/2026-11-20-hai-app/results-windows-user.json)：0.4.0、win32、Node24.22.3、application-cli-real-HAI-B-ECS-A、mock=false，5/5 pass；真实模型列表与Responses SSE完成，结束后自有HTTP/TLS隧道端口释放。报告14个模型、配置模型可用、用量input11/output5 tokens。Windows→ECS→Mac→HAI最小真实流式调用据此记为通过（用户提供完整报告，非助手直接执行）。实际AI工具任务、WSL、A外层恢复、VPN/休眠和长期稳定性仍未验证；[证据来源与边界](../explore/2026-11-20-hai-app/README.md)分别保留，不与本机报告合并为一次调用。

新增11项合成 HAI 回归，默认116/116本机通过，npm run check 与模块语法检查通过。覆盖真实/模拟身份互斥、B-only交付、危险配置与公开 mock token 拒绝、A 凭证替换/文件更新、Unicode SSE、只读列表不发POST、显式单POST、429/503无重试、报告隐私/独占输出及离线安装。TLS 与本机 TCP 子进程替身不代表真实 SSH/ECS；Mac 无 PowerShell，Windows 结果来自上述独立用户报告。

Mac 真实已认证 HAI 模型列表HTTP200，14个模型，配置模型可用。随后仅发送一次固定无敏感短提示词，经本机 B 客户端适配器 → A mTLS bridge → HAI，HTTP200、response.completed成功，报告用量input11/output5 tokens。无正文或凭证日志，[原始安全报告](../explore/2026-11-20-hai-app/results-mac-local.json)明确标记 Mac-local-client-TLS-A-real-HAI-not-B-ECS-A。这是一次计费调用，不重复发送；不证明 Windows/WSL/ECS端到端或实际 Codex 会话。

助手自有旧 mock publisher 已正常停止0，新真实 publish-app 保持前台，A TLS18081与ECS loopback18083沿用既有路径；其listening/starting不代表远端就绪，须以B结果确认。操作与下一次集中试用见[真实接入](real-hai.md)。

后续Mac重复启动失败时，只读检查确认已有同配置publisher监听18081，mTLS /healthz返回200，未停止旧进程或新发模型请求。用户按说明继续后反馈“好的成功了”，记录为启动流程成功反馈；没有完整Codex任务/读写输出，不据此宣布工具任务已验收。

## 应用 CLI 0.3.0（2026-11-20）

本轮交付后，用户提供完整 Windows JSON：[原报告](../explore/2026-11-20-app-cli/results-windows-user.json)与[证据边界](../explore/2026-11-20-app-cli/README.md)。win32、Node 24.22.3、application-cli-B-ECS-A，21/21 pass，mock=true、hai=not_called。据此记录 Windows 新 CLI 的双向 TLS、协议与 B 自有 SSH 受控中断后的正式控制器自动恢复、无 POST 重放、清理与端口释放通过（用户提交报告，非助手直接执行）。原 JSON 未含 CLI 版本、包哈希或执行时间，不补造。WSL、A 外层恢复、VPN/休眠、真实 HAI 与实际 AI 工具会话仍未验证。

增加13项正式封装回归后，默认105/105本机通过。覆盖版本化mock配置、B-only身份导出/导入、输出不覆盖、凭证环境隔离、错误模式/版本/字段/端口/root/文件权限拒绝、TLS身份不匹配、证书/密钥文件夹带其他身份拒绝、单层ECS参数与保留旧默认检查、启动取消/端口冲突回收、认证失败不重试及安全报告。

集成用正式runApplication与check-app核心、真实双向TLS和受控loopback TCP子进程替身：显式结束自身B传输后，正式runTunnel观察退出、退避和第二attempt，旧流清理/无POST重放、新Unicode SSE、HTTP/TLS端口释放通过。不是探针主动restart；没有实际SSH加密或ECS/Windows/WSL网络验证。A publisher逻辑亦测试一次模拟网络退出后的有界重试与主动停止，但不是实际A外层端到端恢复。

私有B交付包实际tar白名单为普通runtime.tgz、Windows脚本、说明、bundle.json与固定四份B身份；不含A私钥/SSH身份/CA签名私钥/HAI。独立临时目录离线安装后，安装版CLI帮助与init-app-client加载配对成功，不依赖B的OpenSSL。Mac 无 PowerShell，Windows 结果来自上述独立用户报告，不继承旧实验Windows全部PASS。使用见[应用CLI](application-cli.md)。

实际Mac已用init-app生成新版身份，并以publish-app启动A TLS18081及出站SSH；B身份访问本机TLS健康GET为200，ECS18083通过只读ss确认仅为127.0.0.1。只停止助手自己拥有的旧实验进程，旧资产保留。这些 Mac 冒烟检查仅证明 A 入口及远端监听准备；Windows 端到端与 B 自动恢复另据上述用户报告，不证明 WSL 或 A 外层恢复。没有真实HAI请求。历史实验独立7/7回归通过，npm run check与新模块语法检查通过。

## 应用双向 TLS（2026-11-20，新约束）

Jamf/统一日志确认管理策略关闭 Mac Remote Login，旧系统登录链路暂停。新增独立应用 TLS mock 实验；9 项新增测试后，默认 92/92 本机通过。核心集成完整运行 19 项集中验收，通过真实双向 TLS 和不终止 TLS 的本机 TCP relay；单独检查 A 固定客户端指纹、非受信/错误用途的客户端证书、假冒 TLS 服务和占用端口保护。中转捕获的二进制中未出现测试 token、请求路径或合成回复明文（仅针对该 mock 测试样本，不宣称元数据不可见）。

B 交付包实际 tar 清单与白名单一致，只包含短期 B TLS identity，不包含 A 私钥、CA 签名私钥、HAI 配置、mydocs 或其他本机配置。解包后的代码已在独立目录加载配对并访问合成健康入口；不依赖 B 安装 OpenSSL。CLI 的毒化认证环境隔离、报告不覆盖和安全输出均实测通过。

Mac 实际已启动 A 应用 TLS 18081 与 A→ECS 出站反向隧道，ECS 的 18083 通过只读 ss 检查确认为 127.0.0.1 监听；此检查不证明 B→ECS→A 的端到端链路。最终本机 CLI 报告为 20 项通过（19 项核心验收加透明中转捕获检查），保存在 explore/2026-11-20-app-tls/results-local.json。

用户随后在收到最终 Windows 包与命令后回复“全部pass”，据此将 Windows 原生→ECS→Mac 应用双向 TLS mock 的集中验收记为通过（用户报告，未收到完整 result-windows JSON，不补造实际逐项数量/版本/计数）。[原始反馈与边界](../explore/2026-11-20-app-tls/windows-user-report.md)另行保存；本机报告不改写为 Windows 报告，WSL 仍未验证。

B 故障恢复由验收脚本主动重建自己结束的 SSH，不等于产品自动重连。A 外层故障、VPN/休眠、真实 HAI/AI 工具会话、生产权限/撤销与长期稳定性未验证。新的[验收说明](application-tls-validation.md)与 explore 实验 README 提供集中操作步骤；旧 11 PASS 不迁移为新架构证据。

## 验证层次

1. `explore/2026-11-19-forwarding/` 保存最初的 HAI 行为探索。
2. `npm test` 用本机模拟上游验证桥接协议、认证隔离和异常行为，不调用真实模型。
3. `doctor` 验证桥接及配置上游的模型列表；模拟上游标记 `mock: true`、`hai: not_checked`，不证明真实 HAI 可用。
4. `probe --infer` 验证 Responses / SSE；连接真实上游时发送一个极短的计费请求，本机 `dev` 则返回不计费的合成输出。
5. 在 Windows 原生与 WSL 各执行连接、诊断、流式生成和 Codex 任务，完成跨设备验证。

## 自动化覆盖

截至 2026-11-20，默认 `npm test` 共 83 项通过。原有 14 项覆盖错误 token 不访问 HAI、凭证替换与工具头保留、路径/方法限制、SSE 首块及时到达、取消传播、压缩字节保持、429 及重试提示保留、超时与凭证错误、1 MiB 请求体完整性、请求体大小限制、配对隔离与 key 轮换、配置限制、Codex 凭证不进入参数、SSH 安全参数和参数注入拒绝。

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

## 纯本机开发模式（2026-11-20）

新增 14 项后，当前默认 63 / 63 本机测试通过。dev 复用真实 bridge，独立创建模拟上游和临时 client，覆盖 loopback、认证隔离、Unicode SSE、取消/错误/无重放、输出文件保护、启动失败与活动流清理、停止中断、local_only 和 CLI 隔离。临时 SSH 配置不参与该模式；历史 explore 脚本不改动。

Mac 实际运行新 dev CLI（随机端口）后，doctor 为 mock=true、hai=not_checked；probe 的合成 SSE HTTP200/completed、11个输出字符、input/output tokens均0。Ctrl-C退出0并输出 stopped；确认本次临时配置及目录消失。旧中继和历史模拟服务没有接管/重启。

CLI 环境隔离测试给子进程注入非真实的毒化认证值，仍只使用固定模拟凭证；未读取真实认证文件或调用真实模型。类Unix CLI SIGTERM测试通过，Windows该项跳过，不能标记Windows/WSL实机通过。原有默认测试和独立实验回归分开执行。

## 本地安装与版本交付（2026-11-20）

增加 7 项交付回归后，默认 70 / 70 本机通过；历史模拟实验独立 7 / 7 通过。npm run check、全部 src/bin/scripts/test 模块语法与 Git 差异检查通过。

覆盖版本信息从包位置读取而非当前目录、无配置离线输出、文件白名单/缺失入口、意外 npm 自动包含文件拒绝、私有包约束、禁用生命周期脚本、排除合成私密文件、SHA-256、一批产物不覆盖上一批、临时 prefix 离线安装及 npm bin 入口。探针 User-Agent 与 CLI 共用 package.json 版本。

Mac 实际安装包在含空格/单引号的独立临时目录使用，远离源码目录执行 --version 和帮助；安装后 dev 打印的两条安全引用命令实际执行，doctor mock=true/hai=not_checked，SSE completed=true、input/output tokens 均为0。SIGTERM 退出0且临时配置已删除，临时安装目录由测试清理。未改系统全局安装，未访问真实 HAI/SSH，未接管旧服务。

Windows 引用规则有注入测试；安装后 dev 的 Unix SIGTERM 检查在 Windows 跳过，Windows .cmd/PowerShell 与 WSL 实机结果仍未取得。交付方式见 [安装说明](installation.md)，此批不等于真实中转已获授权或端到端已验证。

## B 端集中生命周期入口（2026-11-20）

版本0.2.0增加check-lifecycle，新增13项后默认83/83本机通过。它自己管理一条专用内层SSH，默认不起故障注入；显式--interrupt-ssh后才结束自己的SSH子进程，保留控制循环观察退避、后续attempt与HTTP/统计恢复。报告保存安全元数据，不含token/目标/身份路径/原stderr/模型文本；Mac外层等未测项另列。

本机集成使用实际bridge、历史模拟上游、独立loopback TCP转发替身，验证在途流中断、取消统计、自动重建控制、无多余请求迹象、恢复后新SSE、主动停止和端口释放。刻意插入额外POST时正确报失败；非mock模型列表只发GET、不进入POST。另覆盖真实/dev/无界配置拒绝、原监听保护、模拟认证失败、超时、信号取消、报告独占创建及离线检查失败。

这里的传输替身不是OpenSSH，不证明Windows/WSL或ECS实际恢复。CLI启动前拒绝项由实际Node子进程执行；本轮未新建真实SSH连接、未停止旧隧道或模拟服务、未访问真实HAI。阶段2仍未完成，操作与报告判读见 [集中生命周期检查](lifecycle-checks.md)。
