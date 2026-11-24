# 应用离线诊断

inspect-app 随 0.5.1 交付，仅支持 v1/app-tls；旧安装包不会自动更新。已登记 v2 不能用此命令证明设备授权/证书正常，v2只读诊断是下一批工作。本机合成测试通过，Windows/WSL 实机仍待验收；交付须核对实际提交与包哈希。

## 如何运行

源码目录，检查 Mac 已保存的 v1 publisher（不是 v2 默认项）：

~~~sh
node bin/hai-bridge.mjs inspect-app --role publisher
~~~

指定现有配置，不要求先 setup，也不启动服务：

~~~sh
node bin/hai-bridge.mjs inspect-app --role publisher --server-config /ABS/PATH/server.json
node bin/hai-bridge.mjs inspect-app --role client --client-config /ABS/PATH/client.json --json
~~~

安装本次新构建后，Windows 检查 setup-client 保存的 v1 个人默认项：

~~~powershell
hai-bridge.cmd inspect-app --role client
hai-bridge.cmd inspect-app --role client --json --out '.local\inspection-new.json'
~~~

Linux/WSL/macOS 安装版使用 hai-bridge；WSL 用自己的配置、Node、SSH 和信任文件。默认 client 优先读个人 ~/.hai-bridge/client-default.json 指针，没有指针时才读 client.json；默认 publisher 读取同目录 publisher-default.json。仅 v1 配置/发布指针可完成检查；指向 v2 时拒绝且不读取私钥。可用 --profile-dir 指定另一私有目录，不能同时传显式配置。

## 检查与限制

| 项目 | 离线检查范围 |
| --- | --- |
| 配置与默认指针 | JSON/schema、角色、模式、非 root SSH、回环上游、非特权端口与相对路径解析 |
| 文件 | 文件/目录元数据、可读性、直接符号链接、大小上限、Unix 权限；不自动修复 |
| SSH | 仅本机 ssh -V、ssh-keygen -F 查已有信任记录；未核对在线指纹或认证 |
| 公共 TLS 材料 | CA 与本地叶证书期限、固定指纹、CA 签名、用途；A 可检查服务名 |
| 私有材料 | SSH/TLS 私钥、access.json、A auth.json 仅查元数据，不读取内容 |
| 端口 | A app 或 B HTTP/TLS 回环端口短暂绑定并释放；占用只警告，不停止监听 |

B 私有配对没有 A 的公开叶证书，因此不能离线核实 A 的实际证书指纹/名称或期限；只校验其预期元数据。A 和 B 应分别执行检查。密钥内容/匹配、token 格式与认证、TLS 握手、HAI 登录/可用性、实际生成、云端释放均为 not_checked。Windows ACL 未查会显式警告，不能把 Unix mode 当作 Windows 权限证明。

证书状态区分 valid、near_expiry（48 小时内）、expired、not_yet_valid，给出 UTC 生效/到期时间。证书损坏、错配和过宽私有文件权限为 fail；临期、端口占用或 Windows ACL 不确定为 warn。pass/warn 退出码为 0，fail 为 1；pass 仅代表本次离线检查项，不代表端到端可用。

仅读取有界配置/配对 JSON 与单一公开证书，不输出路径、主机、token、私钥、证书内容、原始 stderr、请求或回复。公开文件读取会核对打开前后的元数据并限制大小；不作为对恶意本机用户的完整文件系统隔离保证。--out 显式创建新报告（Unix 0600），拒绝覆盖；默认不写报告。分享前仍检查文件。

没有 SSH/HTTP/模型请求，不执行 ssh -G 或配置中的 Match/ProxyCommand，不支持 --infer、--base-url、传输降级或在线检查。需要可信的本机 Node/OpenSSH 安装。旧 doctor --offline 语义不变，仍不接受 app-tls；应用在线健康/模型 GET 用 doctor --client-config，实际任务另确认费用。

## 退出与清理状态

本次 runTunnel 统一拥有一个 SSH attempt：TERM → 最多 2 秒等 close → 必要时仅对仍活跃的自有 child 发 KILL → 再等最多 1 秒。等待/停止幂等；已 exit 的 PID 不再发信号；重连前收敛旧 child 与计时器。可捕获 observer 异常及异步 rejection 也清理自有资源，错误内容不透出。

SSH_STOP_TIMEOUT 表示自有 SSH 的退出未确认；应用发 cleanup_failed，同时尽力关闭本地服务，不报完整 stopped。LOCAL_STOP_ERROR 表示本地服务关闭失败。正常停止的 remote_release 仍为 not_checked，不会连接 ECS 去验证或结束未知会话。

父进程 SIGKILL、无法执行 JS 的崩溃、整个终端/机器退出及远端半开不属于这次保障。没有守护进程、系统自启动或远程接管。生命周期替身通过不等于 Windows 真实 OpenSSH、VPN/休眠或 ECS 恢复通过。
