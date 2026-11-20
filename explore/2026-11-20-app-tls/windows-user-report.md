# Windows 应用 TLS mock 验收反馈

2026-11-20，用户在收到最终 Windows 验证包和集中运行命令后回复：

> 全部pass

记录为 Windows 原生 → ECS → Mac 应用双向 TLS 的本轮 mock 验收通过，证据类型为**用户报告**。未收到完整 result-windows JSON，不补造逐项结果、执行时间、运行时版本或实测计数。交付的批量脚本预期覆盖身份/token/明文拒绝、接口限制、JSON/Unicode SSE/并发、取消清理、429/503/Retry-After、超时/上游断线、B 自有 SSH 中断/主动重建/无重放与停止后的端口释放。

该实验不使用 Mac Remote Login，固定合成上游；恢复由测试主动重建自身 SSH，不代表产品自动重连。该反馈不证明 WSL、A 外层故障、VPN/休眠、真实 HAI、实际 AI 工具会话、设备撤销或长期稳定性已通过，也不扩大真实公司数据中继的授权。

本机的独立真实 TLS/透明 TCP 报告保持在 results-local.json；不将其改写为 Windows 报告。正式状态见 docs/validation.md 与 docs/application-tls-validation.md。
