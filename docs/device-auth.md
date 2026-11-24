# 个人设备认证 v2（0.5.1 个人 MVP）

2026-11-25：独立schema2/app-device与schema1/app-tls共存，不自动迁移。用户已登记/批准Windows真实v2，并提供Codex本地读写/修复/4项独立测试及临时haib交互成功反馈。跨主机时钟缺陷已修复；原集中脚本后续工具权限FAIL保留，新包入口/WSL/其他B系统及长期恢复仍待验收。已有设备直接按[0.5.1升级](windows-upgrade.md)，不重复邀请或登记。

## 使用上改变了什么

B 不再持有 TLS 客户端证书，不需要定期接收新证书。首次配对时，B 自己生成一把长期 Ed25519 设备私钥，A 只保存公钥；在 A 核对完整指纹并批准一次。之后 B 启动程序即可自动取得/刷新短期会话。设备授权持续到撤销，私钥文件能被复制则身份也能被克隆，不是物理硬件绑定。

网络路径不变：B 本地 HTTP → B 出站 SSH → ECS loopback → A 出站反向 SSH → A TLS bridge → A 本地 HAI。ECS 不部署应用、不解密应用内容。不启用 Mac Remote Login，不修改公司网络策略或 SSH 转发限制。

普通程序包不含身份。新的邀请文件只包含 A 的公开信任和15分钟有效的一次性秘密，不含 A/B 私钥或 HAI key；仍必须私下传输。以前的私有试用包中的 B 客户端证书属于 v1，不能作为 v2 身份导入。

## 首次准备（先 mock）

以下使用源码入口；安装新程序包后可将 node bin/hai-bridge.mjs 换为 hai-bridge。Node.js 22+、本机 OpenSSH；A 额外需要 OpenSSL。B 无需 OpenSSL，也无需管理员/系统登录权限。SSH 公钥登录和 known_hosts 沿用已准备的各自文件，不自动配置。

A 新建独立模拟实例。替换 USER@ECS 和两个绝对路径；不要把 A 的 SSH 私钥交给 B：

~~~sh
node bin/hai-bridge.mjs init-device --mock \
  --ssh-target USER@ECS --identity-file /ABS/A_ECS_KEY \
  --known-hosts-file /ABS/KNOWN_HOSTS --out .local/device-v2
~~~

输出新的 server.json 绝对路径。下文 A_CONFIG 是该路径，不是字面字符串。初始化不会启动服务或改默认项。

~~~sh
node bin/hai-bridge.mjs invite-device --server-config A_CONFIG --out .local/device-v2/invite-b.json
node bin/hai-bridge.mjs publish-app --server-config A_CONFIG
~~~

同端口不能同时运行旧/新 publisher。使用原 ECS 允许的 relay_port；不要为了并存擅自更改 PermitListen/PermitOpen。需切换时，由用户先正常停止自己的旧 publisher；本轮没有执行这一步。新 publisher 前台保持运行，保持原 VPN/HAI 设置。邀请需在15分钟内登记。

B 私下收到邀请，将其存入本机私有目录。PowerShell：

~~~powershell
node bin/hai-bridge.mjs init-device-client --invitation 'C:\PRIVATE\invite-b.json' --label 'My Windows' --ssh-target USER@ECS --identity-file 'C:\Users\YOU\.ssh\B_ECS_KEY' --known-hosts-file 'C:\Users\YOU\.ssh\known_hosts' --out '.local\device-v2\client.json'
node bin/hai-bridge.mjs enroll-device --client-config '.local\device-v2\client.json'
~~~

保存 B 输出的完整64位设备指纹。enroll-device 自己短暂启动 B 连接，登记后关闭自己的 HTTP/SSH；不需要先另开 connect-app。B 私钥生成在 client.json.device/device.key，永远不传给 A。成功后只删除内部邀请副本，不删除用户接收的源邀请文件。

A 在另一个终端列出设备，核对 B 的指纹再批准：

~~~sh
node bin/hai-bridge.mjs devices --server-config A_CONFIG
node bin/hai-bridge.mjs approve-device --server-config A_CONFIG --device-id B完整指纹
~~~

登记后状态为 pending，不是连接一次就自动信任。批准操作仅是 A 本地 CLI，没有远程批准接口。标签不是身份，不可用标签替代指纹核对。

## B 一次集中检查

A mock publisher 已运行、B 已批准，先停止自己的旧 B connect-app。下面的命令自己启动/停止 B 连接，不调用真实 HAI：

~~~powershell
node bin/hai-bridge.mjs check-device --client-config '.local\device-v2\client.json' --out '.local\device-v2\result-windows.json' --json
# 或源码仓库包装脚本：
powershell -File scripts/windows-device-checks.ps1 -ClientConfig '.local\device-v2\client.json' -Out '.local\device-v2\result-windows-2.json'
~~~

15项：固定服务器 TLS + 设备会话/模拟身份、错误本地 token、错误服务器 pin/name、网络会话缺失/本地 token 不可冒充会话、未知设备/挑战重放、控制路由与方法限制、Unicode JSON/渐进 SSE/四并发、取消上游、429/503不重放、最终健康和两端口释放。每次 --out 需是新文件。失败报告只含安全状态，不含 token、私钥、提示词或回复。

Linux/WSL/macOS B 用同一个 Node CLI 命令；每个系统分别生成自己的设备身份、引用自己的 SSH 文件，不复制 Windows 私钥来冒充另一设备。Windows ACL 隔离尚未实机验证；本实现不会把 chmod 当作 ACL 认证，不宣称生产级凭据保护。

该批量脚本不撤销设备、不刷新 A 证书、不主动断 SSH，也不证明 VPN/睡眠恢复、长期稳定性。v1 的 check-app、try-hai 和 inspect-app 尚未扩展到 v2，不能用它们输出 v2 验收结论。

## 真实接入与日常启动

mock 身份不能翻转为 hai。准备就绪后，A 在新目录执行 init-device --hai，显式提供 --upstream-url、--upstream-auth-file、--model，按以上流程重新私密邀请与批准；B init-device-client 也显式提供相同 --model。不导出 HAI key，不自动读取原个人配置做迁移。真实推理会计费，另安排验证窗口，不混入 mock 检查。

真实 B connect-app 接口仍与 agent 解耦；当前启用 OpenAI 路由白名单，不是所有 HAI provider 都已经适配。日常仍可使用现有启动器：

~~~sh
# A 一次保存新配置，之后 npm run publish（会占用原端口）
node bin/hai-bridge.mjs setup-publisher --server-config A_CONFIG
# 真实 B 一次记住原配置路径，然后在项目目录启动
node bin/hai-bridge.mjs use-client --client-config B_CONFIG
node bin/hai-bridge.mjs start
~~~

use-client 不复制密钥/源配置；原目录不能删除。旧 v2 setup-client 仍兼容，仅记住本机身份目录且拒绝覆盖已有默认项。connect-app、doctor、probe、codex/start 使用显式 v2 配置可走同一链路；真实推理有费用。B agent 只接触本地 token，网络会话由转发器管理。

## 续订、撤销与失败边界

- 设备签名挑战：32字节随机、2分钟、单次使用，绑定 A 实例/设备/授权代次/用途。会话仅 A/B 进程内存，最长10分钟；B 在新请求之前自动刷新。模型 POST 永不自动重放。
- B 用固定 CA/name/SPKI 验证的 TLS 控制响应中的 HTTP Date 计算 A 的时间范围，不将 A 的绝对过期时间直接与 B 的时钟比较。HTTP Date 的1秒精度和整个往返耗时从 B 缓存预算中扣除，不延长 A 的挑战/会话期限；时间头缺失、非法或响应寿命不合理时拒绝。B 缓存同时用本机单调时钟与本机墙钟的经过时间，明显跳钟/模拟睡眠会令下一新请求重新认证。这不是实际 VPN/休眠恢复的验收，也不会绕过 TLS 证书对系统日期的要求。
- A 重启使旧会话失效。B 已缓存会话的第一次请求可能返回401；随后新请求自动认证。不能为了隐藏这个401自动重放已有模型请求；agent 自身可能重试，属于独立行为。
- A 服务器叶证书约7天，48小时内到期则启动/运行时续订，稳定服务器公钥/SPKI 与根信任不变。运行时每分钟检查；正常续订不重启现有连接。约一年根证书不静默替换，剩余30天给提示；无法签出超过根有效期的证书。根过期、A签发密钥丢失、B私钥丢失/被撤销时需手动新配对，不能保证无限无人值守。
- revoke-device --server-config A_CONFIG --device-id B完整指纹 持久保存撤销；每次新请求检查设备表。运行中的服务每500ms轮询取消该设备活动请求（正常本机测试通过，非硬实时保证）。CLI 的 saved 不是运行服务确认；不修改 ECS SSH key，也不承诺撤销已发生的模型计费。撤销身份不可直接重新批准，重新信任应使用新私钥/邀请。
- 状态文件损坏/不可读时拒绝服务；注册表写入用本地锁与原子替换。锁不会自动强占，异常残留时先确认没有活跃写进程，再由用户处理。不要恢复旧注册表快照，否则可能恢复已撤销身份；没有防本机恶意回滚能力。
- 私有文件限制大小、普通文件/非直接symlink、Unix权限；不自动修复权限或替换坏凭据。A 保留 CA 签发私钥，必须像 HAI key 一样保护；B 私钥失窃就撤销。
- 控制请求有大小、全局速率/并发、挑战、会话和设备数上限；当前个人实例最多32设备，不是公共注册服务。每个设备仍使用 A 的同一 HAI 账号，不提供多人账号归属、配额隔离、审批组织或完整审计。

后续多人使用可保留挑战签名/会话基础，但必须新增账号与权限/配额、独立管理面、安全审计、密钥保护与平台 ACL 验证；不把本版作为可直接公网开放的多租户产品。

## 已登记 Windows 的时间修复升级

本节保留早期0.5.0时间修复交付记录。现有真实设备日常使用优先[0.5.1升级](windows-upgrade.md)和[短命令](daily-start.md)；不为补历史报告重复收费实战。

只更新程序，不重新执行 init-device、invite-device、init-device-client、enroll-device 或 approve-device。保留原 client.json、client.json.device 和 SSH 文件。现有 Node HTTPS A 已返回标准 Date，协议/签名内容不变，因此本次 B 修复不要求重启 A。

使用可信交付端给出的新 tgz 与 SHA-256（版本号仍0.5.0，不能以版本号判断新旧代码）。可安装到新的自有 runtime-clockfix prefix，旧 runtime 保留便于回退；不得把整个凭据目录当作程序包覆盖。按[安装说明](installation.md)校验，Windows 示例：

~~~powershell
# 已校验的新包放在当前目录；先停止自己以前的 B connect-app。
$haiRoot = Join-Path $env:USERPROFILE '.hai-bridge-v2-mock'
$haiRuntime = Join-Path $haiRoot 'runtime-clockfix'
npm.cmd install --global --prefix "$haiRuntime" --offline --ignore-scripts --no-audit --no-fund .\hai-bridge-0.5.0.tgz
if ($LASTEXITCODE -ne 0) { throw 'Installation failed; do not run the old CLI by mistake.' }
$haiCli = Join-Path $haiRuntime 'node_modules\hai-bridge\bin\hai-bridge.mjs'
$haiClientConfig = Join-Path $haiRoot 'client.json'
$haiReport = Join-Path $haiRoot ('result-clockfix-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
node "$haiCli" check-device --client-config "$haiClientConfig" --out "$haiReport" --json
~~~

该命令自己拥有并停止 B 的 HTTP/SSH。新报告增加 session_time_basis=authenticated_server_http_date；首项失败如为模型列表 HTTP 错误会给出安全的 http_status/reason，不输出原响应或认证内容。仍以完整15项实机报告为准，不能将本机183项或旧版Windows通过视为新版通过。
