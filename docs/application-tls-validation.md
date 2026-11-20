# 无 Mac 系统登录的应用 TLS 验证

## 决策

2026-11-20 Jamf 与统一日志确认管理脚本成功关闭 Remote Login。暂停以 Mac SSH 服务为终点的旧方案，不重新开启或换端口重建系统登录。应用级候选复用已有到 ECS 的出站 SSH，增加端到端双向 TLS；它不证明真实 HAI/公司数据中继已获授权。

    B 本地 AI 请求 → B 应用 TLS → 出站 SSH → ECS loopback
      → A 出站反向 SSH → A 应用 TLS → A 固定 loopback bridge

实验最后一段固定为 mock。A 不提供远程命令、文件服务或任意上游。A/B 都只作为 ECS 的 SSH 客户端；不需要 Mac Remote Login、管理员权限或新增公网应用端口。

## 安全与实现边界

- A 验证 B 客户端证书及固定证书指纹，B 验证 CA、服务名称与 A 固定证书指纹，TLS 至少 1.3；不得关闭验证。
- B 仅获得 7 天有效的实验客户端身份；A 私钥、CA 签名私钥、HAI/SSO 不进入交付包。包含 B 实验私钥，不能公开上传。配对通过可信渠道交付，校验 SHA-256。
- ECS 只转发 TLS 密文，但可观察连接元数据或阻断链路。TLS 隐藏应用正文不隐藏流量大小/时序，也不消除公司数据流转许可要求。
- B/A 与 ECS 端口均限定 loopback，不自动修改安全组、sshd、VPN、MDM、known_hosts 或 PowerShell 执行策略。
- 固定合成上游与公开 mock token，环境 HAI 认证不读取；无真实模型调用或费用。请求不重试、不重放。

本轮放在源码 explore/2026-11-20-app-tls，未整合主 CLI，也不包含在常规 npm 包。配套 prepare.mjs 单独生成白名单 B 验证包；操作见该目录 README.md。没有 GUI、自启动、生产登记/撤销、无限重连或真实 HAI 接入。

## 集中验收

Mac：run.mjs local 为真实 TLS＋透明 TCP 中转的本机验收；prepare.mjs 生成独立 .local 配对/交付包；run.mjs publish 可启动应用与自己的 A→ECS 反向 SSH。应用默认18081，ECS loopback18083；旧隧道冲突不接管。

Windows：包内 windows-checks.ps1 一次运行，自动建立、自行中断和主动重建本次 B→ECS SSH，不需要手工切终端。默认 B TLS隧道18085，探针HTTP端口随机。WSL 用同一 run.mjs check，提供自己的密钥/信任文件，单独保存报告。

报告覆盖 mTLS/服务身份、缺失/错误 token、证书/CA/名称/指纹失败、明文拒绝、路径方法限制、JSON/Unicode SSE/并发、取消传播、429/503/Retry-After/无重放、idle504/上游502、B 链路中断/恢复后的清理与新请求、自有进程停止及端口释放。先确认固定 mock 服务再发 POST，报告不含认证头、密钥、输入或回复正文。

恢复测试是探针主动重建自己结束的 SSH，**不是常驻产品自动重连证据**。A ready 也不代表远端发布已成功，完整链路以 B 的结果为准。

## 未验证项

实际 Windows/WSL/ECS 新链路、A 外层故障、VPN/休眠恢复、真实 HAI、实际 AI 工具会话、长期设备撤销与稳定性均需独立证明。原 Windows 手工 SSH mock 的 11 PASS 不迁移为新架构的通过记录。
