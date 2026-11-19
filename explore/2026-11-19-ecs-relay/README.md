# ECS 中继的纯模拟 bridge 验证

该实验复用 `src/bridge.mjs`，固定模拟上游为本机随机 loopback 端口，bridge 默认监听 `127.0.0.1:18080`。不读取 HAI 配置、环境凭证或真实模型，不重放请求。不要把其他文件夹中的真实 HAI 探针当成本实验脚本运行。

`hai_bridge_public_mock_token_20261119` 是公开的测试占位值，仅用于本模拟服务，不是生产认证。

```sh
node --test explore/2026-11-19-ecs-relay/mock-relay.test.mjs
node explore/2026-11-19-ecs-relay/mock-relay.mjs
```

启动前检查 18080 未被其他服务占用；脚本不会替换已有监听。Ctrl-C 停止本实验的两个服务。SSH 隧道须另行关闭。

## 请求与判定

请求都需要 `Authorization: Bearer hai_bridge_public_mock_token_20261119`，可用 curl 的 `--noproxy '*'` 避免本地代理接管 loopback 请求。

| 请求 | 预期 |
| --- | --- |
| `GET /healthz` | 实际 bridge 返回健康状态 |
| `GET /openai/v1/models` | `mock: true`、模型 ID `relay-ok`、模拟上游计数 |
| 不带认证的 models 请求 | 401，不访问模拟上游 |
| `POST /openai/v1/responses?case=json` | JSON 包含 `relay-ok 中文` |
| `POST /openai/v1/responses?case=stream` | 三个 delta 以约 1 秒间隔输出，随后 completed；需 `curl -N` |
| `POST /openai/v1/responses?case=cancel` | 模拟长流；客户端提前取消后，上游 `cancelledStreams` 增加、`activeStreams` 归零 |
| `POST /openai/v1/responses?case=429` 或 `503` | 原状态、错误码 `mock_429` / `mock_503`、`Retry-After: 7`，不自动重试 |
| `POST /openai/v1/responses?case=stall` | 约 5 秒 idle 后 504 `upstream_timeout` |
| `POST /openai/v1/responses?case=disconnect` | 上游断线，bridge 返回 502 `upstream_unavailable` |

取消流时 curl 的退出码 28（客户端超时）是预期触发方式，但不能单凭退出码判断取消已传播；需再查 models 中的计数或 Mac 的元数据日志。模拟输出字符均非公司数据。

Windows 使用已验证的终止于 Mac 的内层 SSH，将本机 `127.0.0.1:18084` 转发到 Mac `127.0.0.1:18080`。内层主机密钥必须核对，不能关闭主机校验。ECS 只需要公网 SSH 端口；18083 保持 ECS loopback，18080/18084 保持各自客户端 loopback。具体主机、账号和验证进度保存在忽略 Git 的 `mydocs/`。

本机自动化通过不代表 Windows 或 WSL 跨设备已经通过；跨设备结果必须单独记录。公网中继真实 HAI 的授权尚未确认，这个实验不改变该授权边界。

## 2026-11-20 验证进度

新增 [Windows 批量脚本](windows-checks.ps1)：PowerShell 5.1+ 和 Windows 自带 curl.exe，十项自动检查覆盖健康、缺失/错误 token 不触达上游、路径/方法限制、429/503 无重放、idle 504、断线 502、四路并发 SSE、20 秒持续流及取消清理、最终健康。可选 SshRecovery 开关增加一次交互式测试：仅停/重启 Windows 这条测试 SSH，检查在途流中断、Mac 上游清理、旧请求不重放，以及新 SSE 可恢复；这不是自动重连测试。

脚本先确认是本模拟 fixture 才发送 POST。运行期间不要同时手动调用或从 Mac 查询该模拟服务，否则请求计数的无重放断言可能受到干扰。脚本只删除自己创建的 PowerShell jobs，不修改 VPN、SSH 配置、执行策略或其他服务。

已连接的 Windows 可以通过模型列表路径的固定 artifact=windows-checks 参数下载脚本；接口仍由实际 bridge 验证 token，模拟服务只返回这个固定文件，不按查询值读取任意文件。服务启动时缓存脚本；修改脚本后需要在无活动请求时重启模拟服务，并重新核对下载 SHA-256。执行前必须校验所提供的 SHA-256，不自动执行未经校验的下载内容。

新增下载接口自动测试后，本机现有 14 项和独立实验 7 项通过。Mac 本机没有 PowerShell，官方下载连接 GitHub 失败；交付前仅在本机验证了 curl 输出格式及下载内容与文件哈希一致。用户随后报告 Windows 批量脚本 11 PASS，并确认按提示中断/重新启动原来的内层 SSH。由此将十项自动检查及 Windows 内层 SSH 的在途中断、上游清理、无重放和手动恢复记为通过（用户报告，未收到完整新汇总日志）。WSL、真实 HAI、休眠、自动重连、Mac→ECS 外层故障和完整账号权限收紧不属于此脚本。

此前原有 14 项测试与本实验初始 6 项测试通过。Windows 原生已有经内层 SSH 调用实际 bridge 的 models 和 Unicode SSE completed 输出，并确认约每秒分段到达；Mac 端完成计数相应增加、活动流归零。Windows 长流取消后上游 cancelled 计数增加且 active 归零；429/503 状态、错误体及重试提示原样返回，本轮计数未观察到额外请求重放。其余基础场景由上述批量测试补齐，当前模拟 MVP 基础验证收尾。这里只记录模拟数据结果，不据此推断真实 HAI 中继已通过或已获批准。
