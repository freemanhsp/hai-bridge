# 应用 CLI Windows 验收报告

2026-11-20，用户在本轮 0.3.0 私有验证包交付后粘贴了完整 JSON，保存在 [results-windows-user.json](results-windows-user.json)，字段和值保持不变，仅调整排版。证据来源为用户提交的报告，不是助手在 Windows 上直接执行。原报告未包含 CLI 版本、包哈希或执行时间，不补造这些字段。

报告标记 win32、Node 24.22.3、application-cli-B-ECS-A、mock=true、hai=not_called；21 项全部 pass。包括正式 B 控制器在自身 SSH 子进程中断后的自动重试、恢复无 POST 重放、取消清理以及停止后的 HTTP/TLS 隧道端口释放。这不同于旧 explore 实验由探针主动重建 SSH。

未验证：WSL、A 外层故障恢复、VPN/休眠恢复、真实 HAI、实际 AI 工具会话、长期稳定性与设备撤销。通过报告不扩大公司数据经个人 ECS 的授权范围；未开展真实模型调用。

后续优先准备 A 外层受控故障的集中验收，只中断测试程序自己拥有的出站 SSH，不操作 Mac 系统登录、VPN 或其他连接；WSL 独立验收，不重复已通过的基础协议人工检查。
