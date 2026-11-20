# 应用双向 TLS：无 Mac Remote Login 的 mock 验证

独立探索实验，不改变现有 CLI。Node.js 22+，A 生成证书时另需 OpenSSL（支持 -addext）和 tar；B 仅需 Node 与 OpenSSH。没有第三方 npm 依赖，不用 npm install。

## 链路及边界

    B loopback HTTP → B Node TLS client → B 出站 SSH → ECS loopback
      → A 出站反向 SSH → A loopback TLS application → A mock bridge/upstream

两条 SSH 都终止于 ECS，不使用 Mac 系统登录、不执行远程命令、不改 VPN/MDM。ECS 不终止应用 TLS。A 接受客户端证书验证与固定指纹，B 验证实验 CA、服务器名称和固定指纹；不允许忽略证书错误。ECS 仍能观察地址/时序/流量大小，也能阻断链路，不能因此称其完全可信或不可见。

TLS 密钥仅为本次短期实验生成（7 天）。CA 签名私钥生成后删除。Git 不存密钥；交付包只含 B mock 身份，**不可公开上传**。A 私钥及 HAI/SSO 认证不在包中。持有 B 私钥与 ECS SSH 资格者可访问该 mock；此实验不实现生产登记/撤销服务。

本实验只接受公开的 mock token，固定合成上游，不读 HAI 配置或环境认证，不计费。Mac 必须醒着且进程持续运行。公司关闭 Remote Login 不意味着已批准应用中转；真实数据经个人 ECS 的许可仍需单独确认。

## Mac 本机一次验证

在仓库根运行：

    node explore/2026-11-20-app-tls/run.mjs local

生成独立临时证书，启动真实双向 TLS 和透明 TCP relay，执行集中验收，释放自有监听并删除本轮临时资产。这里只证明真实 TLS/HTTP 与本机 TCP 故障恢复，**不是 Windows、WSL 或 ECS 实测**。

## 准备跨设备包和 A 前台服务

在仓库根运行：

    node explore/2026-11-20-app-tls/prepare.mjs

返回 .local 下全新的 directory、archive 和 SHA-256；旧文件不覆盖。将 tgz 通过可信方式送至 B，不通过模型接口下载脚本，不自动执行下载内容。

在 A 启动本次应用与出站 SSH（替换 PAIR_DIR、ECS_HOST、MAC_SSH_KEY、VERIFIED_KNOWN_HOSTS）：

    node explore/2026-11-20-app-tls/run.mjs publish --pair PAIR_DIR --target hai-publisher@ECS_HOST --identity MAC_SSH_KEY --known-hosts VERIFIED_KNOWN_HOSTS

应用监听 A 127.0.0.1:18081，反向 SSH 发布为 ECS 127.0.0.1:18083。若旧实验占用 18083，只停止自己确认的旧隧道；脚本不会抢占/杀其他进程。可显式指定 --app-port、--relay-port；ECS 权限必须允许对应监听，不能为通过测试自行放宽策略。

ready 只说明 A 应用已监听、SSH 进程已启动；完整远程转发需 B 测试确认。Ctrl-C 停止本次应用和自有 SSH。无自动重连；A 出站链路断开时退出，真实恢复机制另行验证。

## Windows 一次集中验证

先比较收到的包 SHA-256 与 A 提供的值，再用 Windows 自带 tar 解包：

    Get-FileHash .\hai-app-tls-checks.tgz -Algorithm SHA256
    tar -xzf .\hai-app-tls-checks.tgz
    cd .\hai-app-tls-checks
    .\windows-checks.ps1 -EcsTarget 'hai-jump@ECS_HOST'

默认使用 USERPROFILE/.ssh/hai_ecs_b 与已核对的 known_hosts。可传 -Identity、-KnownHosts、-RelayPort、-TunnelPort、-Report。不会提示接受未知主机指纹、改执行策略或覆盖 known_hosts。若 PowerShell 限制执行脚本，不修改策略；使用等价的 Node 命令：

    node .\explore\2026-11-20-app-tls\run.mjs check --pair .\client --target hai-jump@ECS_HOST --identity C:/Users/YOU/.ssh/hai_ecs_b --known-hosts C:/Users/YOU/.ssh/known_hosts --out result-windows.json

脚本创建 B 127.0.0.1:18085 → ECS 127.0.0.1:18083 的单层 SSH；不使用 hai_mac_b、公钥系统登录或旧 ProxyJump。先确认固定 mock 服务再发 POST。测试期间不要对 A mock 另发请求，计数检查要求独占实验。

身份/token/明文拒绝、接口限制、JSON/Unicode SSE/四路并发、取消清理、429/503 及 Retry-After、idle 504、断线 502、自有 B SSH 中断/重建/无重放、最终健康与端口释放一次运行。中断由程序完成，无需切换终端按 Enter。恢复检查是**测试主动重建连接**，不宣称常驻产品自动重连已实现。

报告仅含测试标签/状态、平台、Node 和证据类型，不含密钥/认证头/请求或回复正文。失败返回非零；已有报告不替换。程序只操作自己的 SSH 子进程。A 外层中断、VPN/休眠、生产 HAI 与长期稳定性不在本批范围。

## WSL

WSL 内需自己的 Node22+、OpenSSH 和已核对的 known_hosts/可用 SSH identity。复制包到 WSL 自己的私有目录（私钥权限 600）；不要假设 Windows agent 自动共享。

    node explore/2026-11-20-app-tls/run.mjs check --pair ./client --target hai-jump@ECS_HOST --identity /home/YOU/.ssh/hai_ecs_b --known-hosts /home/YOU/.ssh/known_hosts --out result-wsl.json

Windows 与 WSL 分开运行并分别保存报告；运行重叠会影响端口/请求计数。独立报告才是相应平台的证据。
