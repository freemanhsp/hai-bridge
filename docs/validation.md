# 验证记录

## 验证层次

1. `explore/2026-11-19-forwarding/` 保存最初的 HAI 行为探索。
2. `npm test` 用本机模拟上游验证桥接协议、认证隔离和异常行为，不调用真实模型。
3. `doctor` 验证桥接到真实 HAI 的模型列表。
4. `probe --infer` 验证真实 Responses / SSE，发送一个极短的计费请求。
5. 在 Windows 原生与 WSL 各执行连接、诊断、流式生成和 Codex 任务，完成跨设备验证。

## 自动化覆盖

目前覆盖 14 项检查：错误 token 不访问 HAI、凭证替换与工具头保留、路径/方法限制、SSE 首块及时到达、取消传播、压缩字节保持、429 及重试提示保留、超时与凭证错误、1 MiB 请求体完整性、请求体大小限制、配对隔离与 key 轮换、配置限制、Codex 凭证不进入参数、SSH 安全参数和参数注入拒绝。

这些检查针对真实代理边界和故障行为，使用临时 loopback 服务及临时目录，运行结束清理测试资源。

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

- Windows 11 原生 OpenSSH 和 npm Codex 入口。
- WSL 独立 SSH、Node.js 和 Codex。
- Mac 远程登录与 B 公钥认证。
- 同局域网及异地获准网络路径。
- 休眠、断网后的有限重连与使用体验。
- 长时间、多工具调用、超大上下文、并发和真实 compaction。

本机测试结果不能标记为 Windows / WSL 跨设备已通过。
