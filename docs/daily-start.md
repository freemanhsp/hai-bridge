# 日常单命令启动（0.5.1）

B 上的工具读写 B 本地项目，模型请求沿既有 B→ECS→A→HAI 路径转发。Mac 不启用 Remote Login，ECS 不部署 Bridge 应用，不修改 VPN/MDM 或全局 Codex 配置。

2026-11-25：用户已在 Windows 11 / Codex 0.171.0 上验证显式 workspace-write + MXC 的本地读写、修复、4/4 测试，并反馈临时 haib 函数的交互式启动正常。0.5.1 将同样参数封装进程序；新包安装后的 haib.cmd 仍需 Windows 验收，不继承旧函数结果。[证据与边界](validation.md)。

## Windows：升级一次，之后 haib.cmd

需要 Node.js 22+、npm、OpenSSH Client 和 Codex。已经成功登记的 B 不重建配置、设备密钥或邀请，不重复 A 审批。

按[现有 Windows 升级](windows-upgrade.md)校验普通 hai-bridge-0.5.1.tgz 并安装。然后只执行一次：

~~~powershell
hai-bridge.cmd use-client --client-config "$env:USERPROFILE\.hai-bridge-v2-hai\client.json"
~~~

use-client 在用户 .hai-bridge/client-default.json 保存原配置的绝对路径。它不复制密钥、修改源配置、续期凭据、启动网络或发送模型请求。可重复执行；明确选择另一配置时只更新这份指针。旧 .hai-bridge/client.json 和旧安装目录均保留。**原 client.json 及其 device 目录仍需保留在原位置。**

每天：

~~~powershell
cd F:\codes\你的项目
haib.cmd
~~~

haib.cmd 等价于 hai-bridge.cmd start，会启动本次 B HTTP/出站 SSH，再启动一个交互式 Codex；正常退出或 Ctrl-C 时请求关闭本次自有资源。生成任务计费，项目文件/命令输出可能成为模型输入；仅使用获准数据。不在私有配置/设备目录启动。

不需要先启动 connect-app 或手工设置 provider/token。已有旧 connect-app/start 应在自己的终端 Ctrl-C 停掉，程序不抢占或杀未知监听。Mac 的 VPN、HAI proxy、真实 publisher 需保持运行。

指定项目、只读会话及 exec：

~~~powershell
haib.cmd --project 'F:\codes\你的项目'
haib.cmd -- --sandbox read-only
haib.cmd -- exec '介绍这个测试项目的结构'
~~~

-- 前是 Bridge 参数，后面交给 Codex。Windows 默认注入 exec-local 的 --sandbox workspace-write 与 windows.sandbox="mxc"；Mac/Linux 不注入 Windows 配置。显式沙箱模式、权限 profile 或 Windows backend 配置保留，管理策略仍由 Codex 强制执行，不绕过 sandbox/rules。review 使用其兼容的配置路径，尚未独立实战。

不想保存默认项时仍可用：

~~~powershell
hai-bridge.cmd start --client-config "$env:USERPROFILE\.hai-bridge-v2-hai\client.json"
~~~

新指针优先于旧默认 client.json；指针损坏或所选配置丢失时停止，不静默换回旧设备身份。有效指针可用 use-client 明确选择另一配置；损坏指针需单独处理，不自动覆盖修复。不要为此重新生成密钥。

## Mac A：保持原服务，升级 B 不要求重启 A

既有真实 v2 publisher、HAI 和 VPN 正常时，保持原终端运行。B 0.5.1 不改协议/信任，A 不必为此次 B 启动器升级重新初始化或重启。

如果 A 曾通过 setup-publisher 保存了正确的真实 v2 配置，源码目录日常运行：

~~~sh
npm run publish
~~~

没有保存过，或默认指向旧实例时，使用此前成功的完整命令：

~~~sh
node bin/hai-bridge.mjs publish-app --server-config /原来成功的真实v2/server.json
~~~

不要每次用 prepare-device-hai 生成新 A 实例。setup-publisher 不覆盖既有默认项；遇到旧指针先显式指定原配置，另行安排默认项迁移。

本地已监听不表示端到端成功；forward_ready 只表示 OpenSSH 确认 ECS 的预期回环转发监听。starting 是连接中，不是成功确认。publisher 前台常驻，关闭终端/休眠/强杀不等于已验证清理。

## 程序、凭据与旧入口

普通 tgz 只含运行代码和正式文档，**没有凭据**。升级不会更新邀请、SSH key、设备批准、根信任或身份。v2 使用 B 长期设备密钥和自动短会话，A 续订服务器叶证书；根轮换仍需明确重新信任。旧 v1 客户端证书仍受原短期限限制，不因升级转成 v2。[凭据说明](credentials.md)。

旧 setup-client 入口仍可私下导入既有配置，但拒绝覆盖；0.5.1 现有设备优先 use-client，只记路径。没有新指针时，start 仍沿用 .hai-bridge/client.json，维持兼容；因此裸旧命令不能保证选中了新 v2。

Windows 用 .cmd，避免调用 npm 生成的 .ps1；不修改执行策略。新 haib.cmd 是安装包入口，不是之前的临时 PowerShell 函数，重开窗口仍存在；找不到时检查 npm prefix -g 与 PATH，不能安装公开同名包。

## 当前限制

最终本机 Node22/24 两套环境均213/213回归通过，独立prefix离线安装覆盖新默认指针、haib入口、参数位置、显式只读保留及自有清理；原候选包212项记录保留，不等同 Windows 新包完整验收。只跑 --help 不能证明模型工具读写权限，自动无模型读写预检尚待开发。

短暂 SSH 退出沿用有界重连；模型 POST 不由 Bridge 自动重放，工具会话不自动重启。Codex 自身重试是独立行为。Windows 新包定向 Ctrl-C 清理、A 外层中断、VPN/休眠、WSL/macOS/Linux B 和长期稳定性仍需独立验收。

WSL 使用自己的 Node/SSH/Codex、Linux 路径和独立设备身份。命令为 haib 或 hai-bridge start；不要复制 Windows 私钥/C:\ 路径，不能共享 Windows 的实测标签。
