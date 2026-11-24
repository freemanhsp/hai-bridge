# HAI Bridge 架构与边界

## 当前路径（0.5.1 个人 MVP，2026-11-25）

    B 本地 AI 工具 → B HTTP loopback → 应用 TLS / B 出站 SSH
      → ECS loopback → A 出站反向 SSH → A TLS bridge
      → A 本地已认证 HAI → 公司平台

B 的项目读取、命令和工具执行仍发生在 B；可能进入模型上下文的文件内容与命令输出经 A 转发。A 不提供远程命令或文件服务。Mac Remote Login 已被管理策略关闭，本方案不重新开启它，也不安装替代 sshd。

两条 SSH 都终止于 ECS，但应用 TLS 端点在 A/B。ECS 仅运行现有 SSH 转发，不部署 Bridge、存储 HAI 凭据或终止应用 TLS；仍能看到连接元数据、大小/时序并中断流量。加密不免除数据流转许可。用户已确认可尝试个人 Windows→个人 ECS→公司 Mac 的路径；不推断适用于其他用户、设备或用途。

默认端口：A TLS18081、ECS loopback18083、B HTTP18084、B TLS隧道18085，HAI 在 A loopback6655。程序仅申请 loopback 转发，实际地址和权限仍由 ECS SSH 策略约束，不自动修改安全组、sshd、VPN、MDM 或信任文件。

## 职责与启动

- publish-app：A TLS 服务与 A→ECS 反向 SSH，前台独立运行；源码快捷入口 npm run publish。
- connect-app：B HTTP 适配器与 B→ECS SSH，与 AI agent 解耦；目前需自己的显式配置或旧默认路径。
- start：B 的便利组合；等待固定服务器 TLS、健康与模型列表成功，再启动一次 Codex，退出清理本次资源。不是通用多 agent 启动器。
- haib：start的安装包短入口；use-client只记住原真实配置路径，新指针优先于旧默认。不复制/更新设备身份，损坏指针不静默回退。
- setup-publisher：只保存原 server.json 的绝对路径；setup-client：v1私下复制已有 B 配对，v2仅记住本机设备身份目录，不复制设备私钥。均不启动服务、不改旧实例。

start 保持 B 项目 cwd，不改全局工具配置。Windows默认显式workspace-write与MXC，其他系统不注入Windows键，用户显式只读/权限/backend选择保留；管理策略仍强制执行。help只证明参数可解析，自动无模型读写预检尚待实现。publisher不由某次B会话管理；A需醒着联网并保持前台HAI/服务，没有后台、自启动或远程接管功能。

## 认证与凭据

当前 v1 为独立真实/mock CA、服务名与配对标记，TLS至少1.3；A 校验 CA、客户端证书用途与固定 B 整证书指纹，B 校验 CA、服务名、用途与固定 A 指纹。CA/A/B 证书均约7天，生成后销毁 CA 签名私钥。真实 B 另持随机 bridge token，不能用公开 mock token。

HAI/SSO 只在 A；每次真实请求读取 A 明确 auth.json 的 OPENAI_API_KEY 并替换认证，不接受 HAI_UPSTREAM_API_KEY/HAI_BRIDGE_TOKEN 的认证来源覆盖。公司认证刷新仍由 HAI 负责。B 的应用私钥、bridge token 与 B 自己的 ECS SSH 私钥不是 HAI 登录凭据。

v1 单一 B 指纹和共享实例 token 不是设备登记平台，不能直接续签。新增独立 schema2/app-device：服务器TLS认证 A（CA/名称/稳定SPKI），B本机单一Ed25519长期私钥签一次性挑战换短期会话。A私密15分钟邀请、pending登记、本机指纹批准/撤销；授权代次和持久设备表逐请求校验，活动流500ms轮询撤销。A保留CA签名能力，在启动/每分钟检查时续订7天服务器叶证书，约一年根不自动更换；B无客户端证书。设备记录与协议详见[个人设备v2](device-auth.md)。复制私钥仍会克隆身份，不证明硬件身份。

v2 控制面仅精确 POST /bridge/v2/enroll、challenge、session，不转发 HAI；正文16KiB、全局120次/分钟与8并发、128挑战（每设备5）、256会话（每设备16）、32设备。数据请求最多32并发、每设备8；这些是个人实例的有界限制，不是多租户配额体系。B本地token与网络会话分开，控制路由不向本地agent开放。模型请求不重放；A重启后首次旧会话请求可401，后续新请求重新认证。

## 请求与诊断

当前真实入口仅启用 OpenAI 白名单：模型列表、Responses、Chat Completions 和 embeddings 等已列明路径/方法。底层虽有其他 provider 路由代码，不代表当前真实模式启用或 HAI/agent 已兼容。其他协议应独立验收；不提供任意 URL 代理或通用协议转换。

正文、工具调用、JSON/SSE 以字节流转发，不解析或重写模型内容。背压、请求体上限、hop-by-hop 头清理与认证替换在 bridge 层处理；上游状态、错误正文、Retry-After 和关联 ID 传给 B。错误正文透传给调用方不等于写入日志。桥接不跟随重定向、不自动重试/重放模型 POST；取消/断开关闭对应上游连接。AI agent 自身重试属于独立行为。

已有安全生命周期事件、doctor、实验报告和请求 ID；真实 publisher 尚未接入完整请求元数据日志/轮转/report 导出层。底层 logger 钩子不能视为已经具备日常监控。规划中的统计应不缓存正文，不从字节数推算真实计费。

inspect-app目前仅v1：复用纯配置校验，读取公开证书/配对元数据，仅查私钥、token 与 HAI auth 的文件元数据；离线检查不启动 SSH/HTTP/模型请求。可输出安全摘要报告；不能离线证明密钥匹配或真实认证。v2 check-device是显式在线mock批量入口，不能作为离线报告；v2公开信任/登记诊断后续收敛。见[离线诊断](application-inspection.md)。

listening 只表示本地服务启动；starting 是 SSH 尝试；forward_ready 是尽力匹配 OpenSSH 预期远端监听成功诊断，不是安全决策或 B→HAI 健康保证。doctor 的健康/模型 GET 成功也不等于实际生成或完整工具任务通过。

## 生命周期与残留

正常 Ctrl-C/TERM 与可捕获 observer 异常统一清理本次 SSH：TERM→最多2秒→仍活跃才KILL→再等最多1秒。停止幂等、已退出PID不再发信号、重连前清理旧child；应用层不再使用另一强杀timer。未确认退出报 SSH_STOP_TIMEOUT/cleanup_failed，本地关闭失败报 LOCAL_STOP_ERROR，不宣称完整清理；不结束未知进程。超时为等待上限，不承诺操作系统必然完成退出。

Node 被强杀可能留下本地 SSH；客户端/网络失联可能使远端 sshd 暂保留反向监听。客户端 ServerAliveInterval15/CountMax3 不保证 ECS45秒释放，服务端心跳也不能识别仍在线响应的孤儿 SSH。已观察到一次旧远端会话占用；精确触发原因未确定，本次本机清理加固不豁免这些风险。正常 stopped 的 remote_release 仍为 not_checked。见[排障](troubleshooting.md)及[下一批任务](next-development.md)。

## 证据与历史

原P0/v2本机历史结果保留，0.5.1用户已提供Windows真实Codex本地修复/4项独立测试及临时haib交互成功反馈。原完整脚本read-only失败报告不改写为PASS，新包Windows入口仍待验收。归档时另加强npm生命周期防护；完整回归见[验证记录](validation.md)。WSL/Linux/macOS B、Windows ACL、实际撤销/叶续签/A外链、VPN/睡眠与长期稳定性仍需独立实测。

旧路径为 B 内层 SSH 经 ECS 终止于 Mac SSH22，再访问 Mac bridge；其代码/实验保留但不继续部署。旧 token 环境覆盖、多 provider 配置和 Mac 系统登录步骤不能套用到当前真实 app-tls。历史见[中继 CLI](relay-cli.md)、[旧配置](configuration.md)与[探索资产](../explore/README.md)。
