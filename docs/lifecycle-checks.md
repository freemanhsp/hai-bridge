# B 端集中生命周期验收

历史内层 SSH 验收：管理策略关闭 Mac Remote Login 后已暂停推进。新的无需 Mac 系统登录的批量验收见[应用 TLS 验证](application-tls-validation.md)，本页保留以解释旧结果和工具。

0.2.0 新增 check-lifecycle，Windows 原生与 WSL 使用同一个 Node 入口，无需另外下载 PowerShell/bash 脚本。它启动并管理本次专用内层 SSH，不接管现有 connect。当前只验收模拟服务和 B 内层，Mac→ECS 外层故障、真实断网、休眠、认证/指纹变化及真实 HAI 不在通过范围内。

## 准备一次测试窗口

1. 两端使用同一份安装包，核对版本及 SHA-256。0.1.0 没有此命令。
2. Mac 保持已准备好的 publisher 与历史模拟服务 18080 运行。不要重复启动已有服务，不需要修改 VPN、安全组或 SSH 权限。本批代码不会自动操作 Mac/ECS。
3. B 使用 init-relay-client --mock 生成的独立配置、SSH profile 和已核对的两层主机记录；WSL 用自己的密钥、信任文件和端口。
4. B 同端口的旧手工 SSH/connect 若仍运行，由用户在其专属终端 Ctrl-C 停止；或初始化另一个本地端口。检查发现占用会失败，不会杀旧进程。不要先另开 connect，新命令会自己启动它。
5. 测试窗口内其他客户端不要访问同一个模拟服务，尤其不要同时跑 Windows 与 WSL，避免污染活动流及请求计数。

必须满足固定公开模拟 token、relay-ok 模型、目标 Mac loopback 18080、hai-bridge-mac 别名及独立 SSH profile。真实配对文件、dev 的 local_only 配置不接受。离线自检不得有 fail；静态 profile 和两层 trust 必须明确 pass，复杂可执行 profile/缺失信任不自动跳过，Windows ACL 警告仍需自行确认。

## 一条命令运行 B 端

Windows PowerShell（源码模式也可将 hai-bridge.cmd 换成 node bin/hai-bridge.mjs）：

~~~powershell
hai-bridge.cmd check-lifecycle --client-config .local/relay-mock.json --out .local/lifecycle-windows.json --interrupt-ssh --json
~~~

WSL（顺序另跑，不与 Windows 同时使用同一模拟上游）：

~~~sh
hai-bridge check-lifecycle --client-config .local/relay-mock-wsl.json --out .local/lifecycle-wsl.json --interrupt-ssh --json
~~~

输出文件必须不存在；再次运行换一个 --out 路径。--interrupt-ssh 是明确故障注入选择：中断本命令直接创建的 SSH 子进程，保留 runTunnel 控制循环，由其有限重连。不是结束其他 SSH，不需查 PID、手动重启 connect，也不是修改网络/VPN。正常停止和最后清理同样只作用于本次子进程。

省略 --interrupt-ssh 时只检查基础起停和流式，恢复项 skip，总结果 partial；退出0不等于恢复验收通过。

## 检查与报告

| id | 检查 |
| --- | --- |
| mock_config / free_port | 仅接受模拟配置，本地端口先短暂绑定/释放 |
| mock_ready | 通过本次隧道读取模型列表，核对 mock=true 与统计；任何 POST 前完成 |
| unicode_sse | 3 段合成 Unicode delta 与 completed |
| inner_recovery | 长流首段已到达、上游 active=1 后结束自有 SSH；流中断、退避与新 attempt、恢复后的活动流归零、cancelled+1、无多余请求迹象 |
| new_request / final_quiet | 恢复后新合成 SSE 完成，最终 active=0、模拟上游 rejectedAuth=0 |
| stop_owned_ssh / port_released | 控制循环主动停止并回收自有子进程，再短暂绑定原本地端口确认释放 |

--json 时终端逐行输出 check 事件，最后 check_summary 带 status 和报告路径。没有 --json 时过程仍是结构化 check 事件，最后一行人类可读。报告含版本/Node/平台、check 结果、SSH 安全状态和 not_checked，不含 token、SSH 目标/身份路径、原始 stderr、提示词或模型文本。SSH starting 不代表连通；以 mock_ready/恢复后 HTTP 及统计为证据。

报告 status=pass 仅表示本次 B 内层模拟检查全部通过；partial 表示恢复项未请求；fail 表示有失败或中断，未运行的项目标记 skip，不继续危险步骤。fail 返回1，其余返回0。失败后仍尝试停止自有 SSH、检查端口并保留部分报告。Unix 文件默认0600；Windows ACL 未自动设置。

正常检查整体最长约90秒，单阶段约30秒，最后停止最多额外约6秒；SIGTERM未回收时只对同一个自有子进程尝试SIGKILL并记失败，不清理其他PID。Ctrl-C/TERM在检查阶段取消并保留失败报告。启动前强制终止或异常崩溃可能留下空/不完整报告，不能视为验收证据。

## 如何解读失败

- offline_preflight_failed：先运行 doctor --offline 查看配置、key/agent及已有信任；不关闭主机校验、不删除信任来重试。
- local_port_unavailable：确认是自己的旧专用隧道后手动停止，或改用新本地端口。
- not_expected_mock：目标不是此模拟服务，已停止，不发送模型 POST。
- mock_ready_or_cleanup_timeout：核对 Mac publisher/mock仍在运行，检查授权网络与转发目标，starting不能当就绪。
- inflight_not_interrupted / no_automatic_ssh_retry_observed：未观测到预期内层断流或自动重建；不能拿人工重启替代此次结果。
- unexpected_requests_or_replay / cancelled_stream_not_cleaned：查看是否有其他客户端污染统计，或出现多余请求/活动流；失败不等同于确定发现产品bug。
- ssh_stop_timeout / ssh_not_stopped_by_checker：自有SSH未按预期停止或提前退出；端口检查结果另列，不能视为正常生命周期通过。

请求数检查扣除本命令收到完整统计响应的 GET；恢复过程中已到达上游但丢失响应的 GET、其他客户端活动都可能造成歧义并失败。计数只是独占模拟窗口内的无多余请求迹象，不是对全部业务/AI客户端无重放的证明。

## 当前验证边界

Mac 本机测试使用实际 bridge、历史模拟上游及独立 loopback TCP 转发替身，证明检查编排、真实流断开与清理、失败识别和报告保护。它不是 OpenSSH 加密或 Windows/WSL/ECS 实测。自动化另刻意插入额外 POST，确认报告失败；认证失败也是模拟子进程，不是真实身份测试。

本批不需要另一台设备配合开发，但执行此命令会使用给定的既有获准 SSH 路径。Windows/WSL 首次报告和 Mac 外层协同工具仍待后续；旧历史 windows-checks.ps1 的11 PASS不替代本轮结果。
