# 文档索引

2026-11-21：当前为应用mTLS + A/B出站ECS SSH，源码0.5.0。本机137项回归与Windows0.4.0真实报告分开；历史系统登录方案不继续部署。

## 当前使用与交付

- [日常启动](daily-start.md)：Mac短命令、Windows安装/导入/start、集中脚本与限制。
- [安装与版本](installation.md)：普通包白名单、哈希、离线安装、同版本不同构建。
- [真实HAI首次接入](real-hai.md)：0.4.0私有试用历史；已有成功配对不重复计费探针。
- [凭据与设备信任](credentials.md)：包与身份区别、7天期限、未实现的登记/续期机制。
- [应用链路排障](troubleshooting.md)：状态含义、只读诊断、端口残留与安全清理边界。
- [架构与边界](architecture.md)：当前职责/认证/协议/生命周期，哪些能力尚未实现。

## 开发与证据

- [纯本机开发](development.md)：dev合成服务、默认回归、测试隔离。
- [应用mock CLI](application-cli.md)与[应用TLS实验](application-tls-validation.md)：独立mock验证，不冒充真实任务。
- [验证记录](validation.md)：实测、用户报告、历史与未验证项。
- [推进顺序](roadmap.md)与[下一次开发任务](next-development.md)：先清理/诊断，再独立验收与凭据v2。
- [探索索引](../explore/README.md)：原始历史资产和安全测试汇总。

## 历史入口

[旧配置](configuration.md)后半、[中继CLI](relay-cli.md)、[旧生命周期验收](lifecycle-checks.md)和[离线doctor](offline-checks.md)主要面向旧SSH方案；不能直接用于app-tls或据此重新开启Mac Remote Login。当前应用offline诊断仍待开发。
