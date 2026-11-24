# 离线自检

范围提示（2026-11-25）：本页doctor --offline针对旧SSH配置与dev local_only，不能加载app-tls或app-device配置。不要为使用旧入口重新启用Mac系统登录。v1应用离线诊断已实现[inspect-app](application-inspection.md)，v2离线诊断仍为[下一批任务](next-development.md)；在线检查与端口排障见[应用排障](troubleshooting.md)。

不方便切换设备或连接真实 HAI 时，先检查本机准备情况。

在 B 检查 client，默认读 .local/client.json；中继模拟配置请显式指定：

~~~sh
node bin/hai-bridge.mjs doctor --offline --client-config .local/relay-mock.json
~~~

在 Mac 检查 publisher：

~~~sh
node bin/hai-bridge.mjs doctor --offline --publisher-config .local/publisher.json
~~~

加 --json 输出机器可读报告；不加时输出逐项结果及 Next 提示。只能选一种配置，不能混用 --base-url、--server-config 或 --infer。

## 检查范围

dev 生成的 local_only=true 配置不需要 SSH，相关可执行文件和主机信任项直接跳过；服务正在运行时本地端口占用仍是正常警告。

- Node.js 22+ 与 OpenSSH 是否可用。
- JSON 可读性、字段/端口/loopback/token 格式；内容及 token 不显示。
- 显式私钥路径是否是可读普通文件；只检查元数据，不读取私钥内容，也不证明密钥有效或公钥已授权。
- Unix 配置/私钥的 group、other 权限位；不会自动 chmod。未审计所有者、目录权限或 ACL，Windows ACL 明确显示未检查。
- 独立 SSH profile 的简单明确 Host 块、各跳板 identity 和已有主机信任记录。支持带空格的生成路径、HostKeyAlias、非默认端口及已哈希的 known_hosts。
- B 本地端口短暂 loopback 绑定后立即释放，不发 HTTP/SSH 请求、不替换已有监听。Mac publisher 的 ECS 远端端口不会被探测。

## 结果含义

pass：该本机检查通过；warn：有潜在问题或不能完整判断；fail：发现明确的配置/文件等问题；skip：该项不属于本机检查范围。

报告整体仅在存在 fail 时返回退出码 1，其余返回 0。因此脚本不能只看退出码断言全部通过，应同时检查 status 和各项结果。

端口占用显示 warn：可能是正常运行的旧隧道，不代表冲突，也不证明桥接正常。检查新启动条件时可关闭自己原来的专用 SSH；检查现有链路时运行不带 --offline 的 doctor。工具不会杀监听进程。

显式信任文件中的条目缺失/撤销会显示失败；未找到默认用户信任记录或无法完成查找时显示警告，系统全局信任文件未检查。只用本机 ssh-keygen -F 查询已有条目，不获取实时指纹、不自动登记或移除主机信任。发现 revoked 条目必须通过可信管理渠道核对，不能为了连接而直接删掉。

## 严格边界

离线模式不运行 ssh -G，因为 Match exec 等规则可能执行命令。Include、Match、ProxyCommand、KnownHostsCommand、LocalCommand、动态变量、通配或其他复杂配置只标记为不能静态检查，不执行这些规则。旧直连 client 依赖的全局 SSH config、默认身份/agent 也不会被展开。

每份报告固定列出未检查项：远端网络可达性、公钥认证、实时主机指纹、远端转发权限、真实 HAI 可用性。PASS 不等于已连通或可生成模型回复；Windows/WSL 端到端仍需后续验收。
