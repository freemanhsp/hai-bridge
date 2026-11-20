# 日常单命令启动（0.5.0）

复用已经成功的真实 HAI 配对，不重新开放 Mac Remote Login，不在 ECS 安装应用，不修改 VPN/安全组/全局 Codex 配置。B 的工具与工作目录仍在 B；只有模型请求通过现有 B→ECS→A→HAI 链路。

本页描述当前源码日常入口；证书/包区别见[凭据说明](credentials.md)，连接或残留问题见[应用排障](troubleshooting.md)。近期[开发任务](next-development.md)将补生命周期与分层离线诊断，尚无自动续期/后台管理功能。

## 需要安装什么

两端需要 Node.js 22+、npm 和 OpenSSH Client。B 另需预先安装 Codex CLI；本仓库沿用已核对的 Codex 0.163.0 参数，其他版本尚未确认兼容。此次尝试访问官方 Codex 文档返回403，未据此声称核验最新版本。A 继续使用现有 HAI CLI、VPN 和认证；日常启动器不会代替你启动 HAI 或登录公司账号。

普通 hai-bridge-0.5.0.tgz 只含程序和正式文档，**没有凭证**；可以按获准方式交付，也可在核查文档分享范围后放到个人仓库。之前的 hai-app-hai-trial.tgz 含 B 私钥，不可公开上传。安装包校验见[安装说明](installation.md)。安装并不会新建配对或延长证书寿命。

Windows PowerShell，在普通包所在目录：

~~~powershell
# 先核对可信来源的 SHA-256
Get-FileHash .\hai-bridge-0.5.0.tgz -Algorithm SHA256
npm.cmd install --global --offline --ignore-scripts --no-audit --no-fund .\hai-bridge-0.5.0.tgz
hai-bridge.cmd --version
~~~

应输出 hai-bridge 0.5.0。没有发布到 npm，不要安装公开同名包。安装时可能更新当前 npm prefix 的旧版本；不修改配置或停止旧服务。命令找不到时检查 npm.cmd prefix -g 和 PATH，必要时重新打开终端；若有多个 Node/npm 安装，确认实际调用的是本次 prefix 下的程序。PowerShell 用 .cmd，不需要修改执行策略。

## Mac：一次记住配置，日常打开两个程序

如果使用源码，在仓库目录只执行一次：

~~~sh
npm run setup:publisher -- \
  --server-config /ABS/PATH/原先成功的server.json
~~~

此命令仅校验本地配置，并把配置的绝对路径记在 ~/.hai-bridge/publisher-default.json，不启动服务，不复制 HAI key，不替换已有默认项。

每天先保持公司 VPN 与现有 hai proxy start 正常运行；再在仓库终端运行：

~~~sh
npm run publish
~~~

源码快捷命令等价于 node bin/hai-bridge.mjs publish-app，不需要每次填写配置路径。默认已保存时不必重复 setup。若没有保存默认项，程序会提示先设置，不会自动猜测配对目录。如果 Mac 也按安装说明安装了普通包，可用 hai-bridge publish-app 从其他目录执行。HAI 和 publisher 各自前台运行；这个版本不添加后台服务、自启动或“关闭终端后继续运行”。正在运行的旧 publisher 可继续使用；不要同端口再启动第二份。源码更新后的提示要重启 publisher 才生效；旧安装包需要重新打包/安装才会包含这些改动。

启动状态含义：

- 本地服务已监听：A 的本地 TLS 服务可监听，尚未确认 ECS 转发。
- 正在连接中继 (starting)：开始 SSH 连接尝试，不是成功确认；请保持终端打开。
- 中继监听已建立 (forward_ready)：收到 OpenSSH 对当前 ECS→A 转发元组的成功诊断，可以启动 B；不代表 B 的 mTLS、HAI 认证或模型服务已经通过检查。
- 连接中断/重试：明确显示等待秒数与次数；不重放模型请求。
- 已停止本次本地服务：不宣称云端监听已经释放；异常断连的旧 SSH 会话仍可能需要单独排查。

forward_ready 是尽力识别的 OpenSSH 诊断提示，不是安全校验或端到端健康检查。不支持该诊断格式的 OpenSSH 可能没有这条提示，程序不会猜测成功或因此结束连接。若长期只有 starting，在现有 ECS 管理终端运行 ss -ltnp 'sport = :18083' 检查预期监听，或在 B 运行已有配置的 doctor；不要因为命令未返回就判断卡死，也不要把进程存活当成就绪。Ctrl-C 停止本次程序。新状态提示已覆盖本机模拟测试；实际 ECS、Windows/WSL 的本次变更尚未验收。

## Windows：一次导入，日常只运行 start

找到上次真实验证成功后打印的 Client config 路径，即旧交付目录 .local\run-时间\client.json；**不是** bundle.json，也不是只有 TLS 文件的 client-pair 目录。只执行一次：

~~~powershell
hai-bridge.cmd setup-client --client-config 'D:\你的旧交付目录\.local\run-时间\client.json'
~~~

新稳定配置在当前用户 .hai-bridge\client.json；对应 client.json.tls 私下复制 B 的短期证书与桥接 token。SSH identity/known_hosts 仍引用原绝对路径，不复制 A 的 HAI 认证，也不会修改 SSH agent、信任文件或 Windows ACL。可以移动旧交付压缩包/程序，但不要移动仍被引用的 SSH 密钥和 known_hosts。默认项已存在时拒绝覆盖；升级安装不需要重复导入。

每天在**无敏感信息的 B 本地测试项目**中：

~~~powershell
cd F:\codes\你的测试项目
hai-bridge.cmd start
~~~

这一条会占用 B 配置中的 HTTP/隧道端口（通常18084/18085），等待固定指纹双向 TLS，读取健康状态与真实模型列表，然后启动一次交互式 Codex。出现 Codex 界面后，可以让它读写这个 Windows 项目。生成任务会计费，且项目文件、命令输出可能成为模型输入经 A 转发；不要在私有配对目录中启动。

不需要另开 connect-app 或手工配置 Codex 的 provider/token，不改 ~/.codex/config.toml。已运行的旧 connect-app 必须先由你在它的终端 Ctrl-C 停掉；程序不会接管或结束未知监听。

指定项目或传递 Codex 参数：

~~~powershell
hai-bridge.cmd start --project 'F:\codes\你的测试项目'
hai-bridge.cmd start -- exec '介绍这个测试项目的结构'
~~~

start 后、-- 前是 HAI Bridge 的参数；-- 后全部交给 Codex。仍可显式 --client-config PATH 使用原配置，但项目必须在配置父目录之外。HAI_BRIDGE_TOKEN 只注入本次 Codex 子进程环境，不出现在命令参数或状态日志中；不启动共享 Codex daemon。

## 退出、故障与现有限制

Codex 正常结束后，start 关闭本次 B HTTP 和 SSH。Ctrl-C 也请求停止它们与本次 Codex；Windows npm Codex 可能另起原生子进程，所以使用本次活跃 PID 的定向进程树终止，不按进程名称批量结束。Windows 这条 Ctrl-C 进程树行为仍需实机确认；直接关闭整个终端窗口/强制关机不等于已验证优雅清理。

短暂 B SSH 故障沿用有限重连；如果正式控制器最终退出，启动器停止本次 Codex，不自动重启会话，也不重放模型 POST。Codex 自身是否重试请求是独立行为，桥接器不声称控制它。A 的休眠/VPN/外层重连与长期可用性尚未实测。

配对证书仍只有生成时的约7天有效期，复制不会续期。过期后须另安排新配对/迁移；0.5.0 没有自动续期、替换默认项或撤销管理。不要靠关闭证书/指纹校验解决过期。可用 --profile-dir 一个新的私有目录保存新配对，但日常 start 也要显式指定该目录。

## Windows 一次集中检查

仓库附 scripts/windows-session-checks.ps1（普通 .tgz 不包含开发脚本，从同一提交的源码取得）。在停止自己的旧 B 连接后运行：

~~~powershell
.\scripts\windows-session-checks.ps1 `
  -RuntimeArchive 'D:\下载\hai-bridge-0.5.0.tgz' `
  -ExpectedSha256 '替换为可信来源的64位哈希' `
  -ExistingClientConfig 'D:\旧交付\.local\run-时间\client.json' `
  -ProjectDirectory 'F:\codes\你的测试项目'
~~~

脚本校验包、离线安装、首次导入（存在则复用），连续两次 start -- --help 并检查自有端口释放。只发 GET，不做生成或故障注入；窗口会打印通用计费提示，但 --help 不提交任务。安全 JSON 报告写入项目 .local，可只分享报告，不分享配对文件。首次之后可省略 -ExistingClientConfig。

这个脚本只证明启动/正常退出，不证明 Ctrl-C、真实 Codex 读写任务、WSL 或长期恢复。Windows 单命令封装尚未收到新版本实机报告；旧0.4.0真实调用5/5通过不替代此次验收。Mac 本机回归使用真实 mTLS+合成 HAI+TCP传输替身/合成 Codex，并非再次实测真实 HAI。

WSL 使用自己安装的 Node/SSH/Codex、Linux 配对与密钥/信任文件，setup-client 和 start 命令相同；不要直接复用 Windows 的 C:\ 路径，也不假定 agent/localhost 互通。此 PowerShell 脚本不适用于 WSL。
