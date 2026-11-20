# HAI Bridge 架构与边界

## 当前路径（0.5.0，2026-11-21）

    B 本地 AI 工具 → B HTTP loopback → 应用 mTLS / B 出站 SSH
      → ECS loopback → A 出站反向 SSH → A TLS bridge
      → A 本地已认证 HAI → 公司平台

B 的项目读取、命令和工具执行仍发生在 B；可能进入模型上下文的文件内容与命令输出经 A 转发。A 不提供远程命令或文件服务。Mac Remote Login 已被管理策略关闭，本方案不重新开启它，也不安装替代 sshd。

两条 SSH 都终止于 ECS，但应用 TLS 端点在 A/B。ECS 仅运行现有 SSH 转发，不部署 Bridge、存储 HAI 凭据或终止应用 TLS；仍能看到连接元数据、大小/时序并中断流量。加密不免除数据流转许可。用户已确认可尝试个人 Windows→个人 ECS→公司 Mac 的路径；不推断适用于其他用户、设备或用途。

默认端口：A TLS18081、ECS loopback18083、B HTTP18084、B TLS隧道18085，HAI 在 A loopback6655。程序仅申请 loopback 转发，实际地址和权限仍由 ECS SSH 策略约束，不自动修改安全组、sshd、VPN、MDM 或信任文件。

## 职责与启动

- publish-app：A TLS 服务与 A→ECS 反向 SSH，前台独立运行；源码快捷入口 npm run publish。
- connect-app：B HTTP 适配器与 B→ECS SSH，与 AI agent 解耦；目前需自己的显式配置或旧默认路径。
- start：B 的便利组合；等待固定 mTLS、健康与模型列表成功，再启动一次 Codex，退出清理本次资源。不是通用多 agent 启动器。
- setup-publisher：只保存原 server.json 的绝对路径；setup-client：私下复制已有 B 配对到稳定个人目录。均不启动服务、不续期、不接管旧实例。

start 保持 B 项目 cwd，不改全局工具配置。publisher 不由某次 B 会话管理；A 必须醒着、联网并保持前台程序与 HAI 正常运行。没有后台、自启动或远程接管功能。

## 认证与凭据

当前 v1 为独立真实/mock CA、服务名与配对标记，TLS至少1.3；A 校验 CA、客户端证书用途与固定 B 整证书指纹，B 校验 CA、服务名、用途与固定 A 指纹。CA/A/B 证书均约7天，生成后销毁 CA 签名私钥。真实 B 另持随机 bridge token，不能用公开 mock token。

HAI/SSO 只在 A；每次真实请求读取 A 明确 auth.json 的 OPENAI_API_KEY 并替换认证，不接受 HAI_UPSTREAM_API_KEY/HAI_BRIDGE_TOKEN 的认证来源覆盖。公司认证刷新仍由 HAI 负责。B 的应用私钥、bridge token 与 B 自己的 ECS SSH 私钥不是 HAI 登录凭据。

单一 B 指纹和共享实例 token 不是设备登记平台。复制私钥会克隆同一身份，不证明物理设备；没有独立设备撤销、自动续期或过期恢复。详情与迁移边界见[凭据说明](credentials.md)。

## 请求与诊断

当前真实入口仅启用 OpenAI 白名单：模型列表、Responses、Chat Completions 和 embeddings 等已列明路径/方法。底层虽有其他 provider 路由代码，不代表当前真实模式启用或 HAI/agent 已兼容。其他协议应独立验收；不提供任意 URL 代理或通用协议转换。

正文、工具调用、JSON/SSE 以字节流转发，不解析或重写模型内容。背压、请求体上限、hop-by-hop 头清理与认证替换在 bridge 层处理；上游状态、错误正文、Retry-After 和关联 ID 传给 B。错误正文透传给调用方不等于写入日志。桥接不跟随重定向、不自动重试/重放模型 POST；取消/断开关闭对应上游连接。AI agent 自身重试属于独立行为。

已有安全生命周期事件、doctor、实验报告和请求 ID；真实 publisher 尚未接入完整请求元数据日志/轮转/report 导出层。底层 logger 钩子不能视为已经具备日常监控。规划中的统计应不缓存正文，不从字节数推算真实计费。

listening 只表示本地服务启动；starting 是 SSH 尝试；forward_ready 是尽力匹配 OpenSSH 预期远端监听成功诊断，不是安全决策或 B→HAI 健康保证。doctor 的健康/模型 GET 成功也不等于实际生成或完整工具任务通过。

## 生命周期与残留

正常 Ctrl-C/TERM 请求结束本次自有 SSH 并关闭服务，应用层对自有 SSH 有2秒强杀兜底；不结束未知进程。现有 finally 异常路径和计时器/子进程竞争仍需专项补齐，不能承诺任意退出都回收。

Node 被强杀可能留下本地 SSH；客户端/网络失联可能使远端 sshd 暂保留反向监听。客户端 ServerAliveInterval15/CountMax3 不保证 ECS45秒释放，服务端心跳也不能识别仍在线响应的孤儿 SSH。已观察到一次旧远端会话占用；精确触发原因未确定，0.5.0不豁免此风险。状态提示不等于清理问题已修复。见[排障](troubleshooting.md)及[下一批任务](next-development.md)。

## 证据与历史

本机137/137回归通过；Windows mock21/21和0.4.0真实模型列表/流式5/5为独立用户报告。0.5.0启动器、WSL/Linux/其他Mac-B、真实工具任务、A异常恢复与长期稳定性未验收；新提示的完整真实冒烟亦未完成。详见[验证记录](validation.md)。

旧路径为 B 内层 SSH 经 ECS 终止于 Mac SSH22，再访问 Mac bridge；其代码/实验保留但不继续部署。旧 token 环境覆盖、多 provider 配置和 Mac 系统登录步骤不能套用到当前真实 app-tls。历史见[中继 CLI](relay-cli.md)、[旧配置](configuration.md)与[探索资产](../explore/README.md)。
