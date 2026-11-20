# 应用 TLS mock CLI（0.3.0 起）

本页描述隔离的 mock 模式。0.4.0 另增显式 --hai 的[真实接入](real-hai.md)，不能将旧 mock 配对改成真实模式。本页命令固定合成上游，不读 HAI/SSO、不计费，不用于实际 AI 工具会话。A/B 均只运行 ECS 出站 SSH；云服务器只保留现有 SSH 服务与 loopback 转发，不部署我们的程序，不开启 Mac Remote Login。

0.5.0日常快捷命令另见[日常启动](daily-start.md)。forward_ready仅是远端监听诊断，不代表完整就绪或异常残留已修复；当前问题检查见[排障](troubleshooting.md)，待实现项见[开发交接](next-development.md)。

## A 一次初始化

需要 Node22+、OpenSSH，以及支持 -addext 的 OpenSSL。以下命令从当前目录写入新的 .local/app/app-tls-*，不会覆盖已有配对：

    hai-bridge init-app --mock --ssh-target hai-publisher@ECS_HOST --identity-file /Users/YOU/.ssh/hai_ecs_a --known-hosts-file /PATH/verified_known_hosts

输出 A 的 server.json 和仅供 B 的 client-pair 目录。只交付 client-pair；它含 B 的 7 天实验 TLS 私钥，不含 A 私钥、A SSH identity、CA 签名私钥或 HAI。CA 签名私钥生成后丢弃，证书过期需要新配对，不提供自动续期/生产撤销平台。

配置有明确 schema_version=1、transport=app-tls、role 和 mode=mock。未知版本、与配对不符的模式和额外字段均拒绝；新 CLI 不直接接受旧 explore 配对，请重新初始化。输出目录用 --out 指定；--app-port 默认18081、--relay-port 默认18083、--ssh-port 默认22、--max-retries 默认5（0–10）。应用/转发端口只能是1024以上的 loopback 端口。

## A 每次启动

    hai-bridge publish-app --server-config .local/app/app-tls-NEW/server.json

一条命令启动 A 应用 TLS 和出站反向 SSH。ECS 127.0.0.1:18083 → A 127.0.0.1:18081；应用只允许实际 bridge 的模型路径/方法。A 的 listening 事件仅证明本机应用就绪，不证明远端发布；forward_ready 仅表示收到 OpenSSH 对预期远端监听的成功诊断，不证明 B→HAI 完整链路，仍需使用 B 的 doctor/验收。源码日常启动可在 setup-publisher 记住配置后运行 npm run publish，详见[日常启动](daily-start.md)。

## B 一次初始化及每次启动

Windows/WSL 只需 Node22+ 与 OpenSSH，不需要 OpenSSL、Mac SSH 用户或 hai_mac_b。用可信方式取得 client-pair，并核对交付包 SHA-256。

    hai-bridge init-app-client --mock --pairing-dir ./client-pair --ssh-target hai-jump@ECS_HOST --identity-file /PATH/hai_ecs_b --known-hosts-file /PATH/verified_known_hosts
    hai-bridge connect-app

初始化把固定四份 B 身份文件复制到 .local/app-client.json.tls，权限0600/目录0700（Unix）；配置保存在 .local/app-client.json。Windows ACL 由用户/OpenSSH检查，此命令不修改系统 ACL。源目录的其他文件不复制；已有配置或 TLS 目录不覆盖。密钥、信任文件和路径与配置一起保存在 B，不修改全局 SSH config/known_hosts，不接受交互式密码或未知主机指纹。

connect-app 同时启动 B HTTP loopback18084 和 B→ECS SSH；TLS tunnel 默认为18085→ECS loopback18083。可初始化时用 --local-port、--tunnel-port 修改，两者不能相同。若现有监听冲突，失败退出，不杀其他进程。后续可用 --client-config 指定配置。

另一个 B 终端：

    hai-bridge doctor --client-config .local/app-client.json
    hai-bridge probe --client-config .local/app-client.json --infer

app-tls 配置忽略 HAI 凭证环境覆盖；禁止 --base-url override，不允许 legacy connect/codex 误载。probe 先确认固定 mock 模型列表再发 POST。此版本不提供 app-tls 的 offline doctor（旧离线入口属于 SSH 历史实现），也不验证真正 AI 工具会话。

## 生命周期、信任与恢复

publish-app/connect-app 在前台；Ctrl-C 仅停止本次 SSH 子进程和应用，释放自有端口。不安装常驻服务、不修改 VPN/MDM。A 必须醒着、联网并保持进程运行。

网络类 SSH 非零退出按 1/2/4/... 秒退避（单次最多15秒），最多配置的 retry 数；连续运行30秒后重置连续失败预算。认证、主机信任、配置、转发拒绝或端口冲突不自动重试；不会删除 known_hosts 或放宽服务权限。

应用在重连期间保持本地监听；在途请求失败/取消，**不自动重放模型 POST**。网络恢复后新请求重新建立双向 TLS。CA、服务名、A/B证书指纹与证书用途都校验，不允许降级明文。证书问题使请求失败，不靠重启 SSH 来忽略验证。

--json 提供逐行安全生命周期状态，不含认证/密钥/正文；源码 npm 快捷命令使用 npm run --silent publish -- --json 避免 npm 自身标题混入 JSON。listening/starting/forward_ready 都不是端到端 ready。forward_ready 每次 SSH 连接最多一次，携带 forward_scope=relay_listener 和 end_to_end=not_checked；未知 OpenSSH 诊断格式不推断成功。原始 verbose stderr 只在进程内保留有界诊断尾部，不输出或落盘。B SSH 连接活着而 A 外层失联时，单个请求可失败；A 恢复发布后新请求可重新连接，不强制重启 B SSH。

## Windows/WSL 集中验收

当前 Windows 状态：用户已提交 [21/21 pass 的完整报告](../explore/2026-11-20-app-cli/results-windows-user.json)（win32、Node 24.22.3），包括 B 正式控制器自动恢复及端口清理。仅 mock；WSL 与 A 外层恢复仍未验证。此结果独立于旧实验反馈，详见[验证记录](validation.md)。

不要同时运行 connect-app 和 check-app 占用同端口；check-app 自己启动正式应用控制器。

    hai-bridge check-app --client-config .local/app-client.json --out result-windows.json --interrupt-ssh --json

一次覆盖固定 mock 身份、认证/证书/路径限制、Unicode流/并发、取消、错误透传和无重放；--interrupt-ssh 只结束本次 B SSH 子进程，观察正式控制器自动退避重建、旧流清理和新请求成功。它不主动替控制器 restart。省略该选项仅验基本协议，报告 partial，不能称恢复通过。报告独占创建、不含敏感信息。

A 外层故障、VPN/休眠恢复、真实 HAI、真实 AI 工具会话不在本批验收通过范围。运行时版本、平台与 evidence 另存；本机 TCP stub 结果不是实际 SSH/Windows/WSL 结果。新CLI不可直接继承旧实验Windows全部PASS。

源码工作区可单独打包安装包与 B 私有配对：

    npm run pack:app-checks -- --pairing-dir .local/app/app-tls-NEW/client-pair

只包含常规白名单 runtime.tgz、B 四份身份文件、说明和 windows-app-checks.ps1。此包含 B 私钥，不公开上传；普通 npm run pack 不含任何身份或脚本。

Windows 对外层 tgz 核对可信 SHA-256 后解包，在 hai-app-cli-checks 中运行：

    .\windows-app-checks.ps1 -EcsTarget 'hai-jump@ECS_HOST'

脚本校验内层 runtime.tgz，在独立 .local/run-* 前缀离线安装（禁用生命周期、联网和审计），初始化 B 并一次运行恢复验收，不改系统全局安装/执行策略。默认为 USERPROFILE/.ssh/hai_ecs_b 和 known_hosts，可传 -Identity/-KnownHosts/-RelayPort/-LocalPort/-TunnelPort。若 PowerShell 拒绝脚本，使用上面的独立 npm 离线安装与 Node CLI 命令，不修改执行策略。

WSL 独立安装普通 runtime.tgz，使用 WSL 自己的密钥/agent/known_hosts 与私有配对，执行相同 init-app-client/check-app，报告用 result-wsl.json。Windows和WSL分开运行，避免污染实验统计或端口。不假设两边agent或localhost自动共享。
