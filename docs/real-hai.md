# 最小真实 HAI 接入（0.4.0）

本批按用户明确确认可尝试的个人 Windows → 个人 ECS → 公司 Mac HAI 路径开发。此为用户确认的范围，不代表已独立取得或核验公司书面审批；不修改 VPN、MDM、Mac Remote Login、ECS 权限或公网端口。ECS 继续只做 SSH loopback 转发，不部署我们的服务，不终止应用 TLS。

    B 本地工具 → B HTTP → 双向 TLS / B 出站 SSH → ECS loopback
      → A 出站反向 SSH → A TLS bridge → A 本地已认证 HAI → 公司平台

HAI/SSO 认证只留在 A；B 私有配对含独立桥接 token、短期 B TLS 私钥和模型名。不要将私有配对或完整试用包上传 GitHub，普通程序源码/安装包可通过 GitHub 交付。真实与 mock 用不同 CA、服务名、配对标记及随机 token；旧 mock 配对不能靠修改 mode 启用真实 HAI。

## Mac 准备与启动

保持原有 hai proxy start 运行。新增配置，不覆盖旧 mock，不导出 HAI key。指定的是 origin，不能带 /openai/v1：

    node bin/hai-bridge.mjs init-app --hai --upstream-url http://127.0.0.1:6655 --upstream-auth-file /Users/YOU/.codex/auth.json --model YOUR_HAI_MODEL --ssh-target hai-publisher@ECS_HOST --identity-file /Users/YOU/.ssh/hai_ecs_a --known-hosts-file /PATH/verified_known_hosts --out .local/hai-app
    node bin/hai-bridge.mjs publish-app --server-config .local/hai-app/app-tls-NEW/server.json --json

用初始化打印的路径替换 app-tls-NEW。A 固定上游仅支持 HTTP loopback，白名单为 openai 模型/Responses/Chat/embeddings 路径，不提供任意地址转发、远程命令或文件服务。读取明确 auth.json 的 OPENAI_API_KEY，每次请求重读，不继承 HAI_UPSTREAM_API_KEY/HAI_BRIDGE_TOKEN 环境覆盖；认证文件 Unix 权限需仅本人可读。

默认 A TLS18081、ECS loopback18083。与旧 mock 冲突时，只停止自己拥有的旧程序或初始化使用不同端口，不杀其他服务。A 必须醒着、联网且程序运行。证书7天有效，过期重新配对，无自动续期/生产撤销平台。

## Windows 一次试用

Mac 工作区生成私有包：

    npm run pack:hai -- --pairing-dir .local/hai-app/app-tls-NEW/client-pair

将输出的 hai-app-hai-trial.tgz 私下交给 B，通过可信渠道核对 SHA-256，再用 Windows tar 解包。在 hai-app-hai-trial 目录：

    .\windows-hai-trial.ps1 -EcsTarget 'hai-jump@ECS_HOST' -Infer

脚本不修改 PowerShell 执行策略、全局 npm/SSH 配置；如果被执行策略拒绝，改用下方直接 Node 命令。Node22+、OpenSSH 和既有 B ECS 密钥/已核对 known_hosts 必须就绪。不需要 B 的 OpenSSL、Mac SSH 用户或 hai_mac_b。

一次离线安装/配对、启动正式 B 连接、检查真实模型列表，随后发送**一次计费的短流式请求**，内容仅为 Reply only with OK。不做故障注入，不重试模型请求，结束后停止本次 B 应用/SSH 并释放端口。省略 -Infer 只查模型列表，报告 models-only，不等于生成成功。

报告 result-hai-windows.json 路径由脚本打印，可回传；不含认证、提示词或回复正文。返回非零或 fail 时不要反复重跑计费步骤，先按失败阶段检查。脚本同时打印安装 CLI 和 client config 的路径，可用于后续实战，不必重复配对。

## 直接命令与实际工具

0.5.0 已提供更短的日常入口：一次 setup-client 后在项目中 start；Mac 一次 setup-publisher 后 publish-app 无需长配置路径。见[日常单命令启动](daily-start.md)。下面的两终端方式仍可用，不要与 start 同时占用同一端口。

源码已在 Git 中；也可按安装说明使用普通离线 .tgz，单独传 client-pair：

    hai-bridge init-app-client --hai --pairing-dir ./client-pair --ssh-target hai-jump@ECS_HOST --identity-file /PATH/hai_ecs_b --known-hosts-file /PATH/known_hosts
    hai-bridge try-hai --client-config .local/app-client.json --out result-hai.json --infer --json

try-hai 自己拥有连接；不要同时另开占用同端口的 connect-app。日常使用终端一运行：

    hai-bridge connect-app --client-config .local/app-client.json

终端二在**无敏感信息的本地测试项目**中运行：

    hai-bridge doctor --client-config /ABS/PATH/app-client.json
    hai-bridge codex --client-config /ABS/PATH/app-client.json --

工具仍在 B 本地读取项目和运行命令，模型输入/回复经 A HAI。Codex 会话可能产生多次计费请求，需要预先安装 Codex；复用已有 Responses/provider 启动器，不改全局配置。官方 Codex 文档访问返回403，最新兼容性未在线核对；Windows Codex 实际会话需单独验证。

WSL 用自己安装的 Node/SSH/Codex、SSH 密钥/agent/known_hosts 和私有配对执行相同命令，不复用 Windows 实测标签，不假定 localhost/agent 互通。报告另存 result-hai-wsl.json。

## 验证边界

当前 Windows 状态：用户提供的0.4.0[完整真实报告](../explore/2026-11-20-hai-app/results-windows-user.json)5/5 pass，证明本次 B→ECS→A→HAI 的最小模型列表/流式调用及停止清理通过（用户报告）。可以直接复用脚本生成的真实 client 进入本地工具任务，不必重跑 try-hai；不要发送 access.json、私钥或 HAI auth.json 来反馈结果。

mock check-app 保持 mock-only，不能用真实配对运行历史计数/中断测试。真实 trial 不证明 A 外层恢复、VPN/休眠恢复、WSL、实际 Codex 会话或长期稳定性。HTTP429/503 与失败流不重放；恢复后仅新请求继续，不降级 TLS，不跳过证书/指纹验证。具体结果另记[验证记录](validation.md)，不要把开发完成误标为跨设备实测。
