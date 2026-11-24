# 文档索引

2026-11-25：0.5.1封装 Windows 已实测的权限参数、新增 haib 与 use-client；独立 app-device v2、旧 app-tls 和既有出站 ECS 路径保留。本机模拟回归、Windows 用户工具任务反馈与新包待验收项分别记录；不继续历史系统登录方案。

## 当前使用与交付

- [日常启动](daily-start.md)：Mac短命令、Windows配置选择/haib、启动与限制。
- [现有 Windows 升级](windows-upgrade.md)：校验/只升级程序、复用已批准设备、持久 haib.cmd，不重装凭据。
- [个人设备认证 v2](device-auth.md)：私密邀请、本机生成设备密钥、A批准/撤销、自动会话与服务器证书续订、B整批mock检查。
- [v2一键验收与实战](device-acceptance.md)：复用已安装程序，一份独立B脚本串起mock、真实登记/批准、推理与本地Codex任务；首次配对有两个暂停点。
- [安装与版本](installation.md)：普通包白名单、哈希、离线安装、同版本不同构建。
- [真实HAI首次接入](real-hai.md)：0.4.0私有试用历史；已有成功配对不重复计费探针。
- [凭据与设备信任](credentials.md)：v1包/7天期限与v2设备密钥、会话/根信任的区别。
- [应用链路排障](troubleshooting.md)：状态含义、只读诊断、端口残留与安全清理边界。
- [应用离线诊断](application-inspection.md)：inspect-app、安全报告、证书到期与自有清理限制。
- [架构与边界](architecture.md)：当前职责/认证/协议/生命周期，哪些能力尚未实现。

## 开发与证据

- [纯本机开发](development.md)：dev合成服务、默认回归、测试隔离。
- [应用mock CLI](application-cli.md)与[应用TLS实验](application-tls-validation.md)：独立mock验证，不冒充真实任务。
- [验证记录](validation.md)：实测、用户报告、历史与未验证项。
- [推进顺序](roadmap.md)与[下一次开发任务](next-development.md)：当前实现已分批归档；下一批无模型权限预检、v2诊断与独立平台验收。
- [探索索引](../explore/README.md)：原始历史资产和安全测试汇总。

## 历史入口

[旧配置](configuration.md)后半、[中继CLI](relay-cli.md)、[旧生命周期验收](lifecycle-checks.md)和[离线doctor](offline-checks.md)主要面向旧SSH方案；不能直接用于app-tls或据此重新开启Mac Remote Login。当前应用离线诊断使用inspect-app。
