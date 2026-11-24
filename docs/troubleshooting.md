# 当前应用链路排障

v2 app-device请先看[设备认证说明](device-auth.md)：pending需A核对指纹并批准；revoked需新身份/邀请；A重启后缓存会话可能先401，后续新请求自动认证（不重放模型POST）。A叶证书自动续订，根到期或签发密钥损坏需人工处理。设备状态损坏时拒绝服务；写锁不自动删除。check-device是显式mock在线批量检查，inspect-app/try-hai/check-app目前仅支持v1。

下面主要适用于app-tls / 0.5.0；网络/端口与自有清理边界也适用于v2。旧Mac系统登录方案不继续部署。HAI、publisher各自前台运行，B用start或手动connect-app，勿在同端口重复启动。不修改VPN/MDM、公开转发端口或忽略证书校验来恢复。

0.5.1日常入口见[短命令](daily-start.md)。haib.cmd找不到先检查npm prefix/PATH，use-client明确选择原真实配置；不重配设备。新默认指针损坏时拒绝回退，显式配置仍可用于定位；不要删除设备密钥。

## 先看哪一层

| 现象 | 已知含义与下一步 |
| --- | --- |
| 没有安全默认publisher | 先setup-publisher保存已有server.json；已存在默认项不要重复覆盖 |
| 本地服务已监听 | 只确认A本地TLS监听，未确认ECS或HAI |
| starting后无提示 | SSH连接尝试/前台常驻；不能用进程存活判断成功，检查预期ECS监听或B在线doctor |
| forward_ready | OpenSSH对当前ECS→A监听的成功诊断；仍需B固定mTLS与健康/模型检查，不等于实际生成通过 |
| 本地端口占用 | 自己的旧实例可由其终端Ctrl-C；不接管或结束未知监听 |
| 模型能回复但本地工具被策略拒绝 | 分开检查Codex有效sandbox/backend；Windows0.171.0用户已实测workspace-write+MXC，0.5.1封装此默认。显式只读仍保留，不通过关闭sandbox/改执行策略强行验收 |
| forward_conflict | ECS旧反向监听或权限拒绝均可能；先只读查精确端口归属，不自动改端口或策略 |
| authentication / host_key | 核查该设备的SSH身份、公钥授权、已验证known_hosts；不删信任或禁用主机校验 |
| TLS无法就绪 | 检查A/B/CA期限、服务名和固定指纹、网络/A发布；当前泛化错误不能证明是哪一项失败 |
| 401 / 503 / 502 / 504 | 结合安全错误码区分bridge token、A认证可读性、HAI未运行或上游超时；不要只凭HTTP状态认定原因 |
| 429 / 503上游错误 | 平台额度/容量/不可用等问题，bridge不重放POST；HAI策略以平台为准 |
| SSH_STOP_TIMEOUT / cleanup_failed | 自有SSH退出未确认；查看本地服务/SSH状态，不宣称云端释放，不停止未知进程 |
| OBSERVER_ERROR / LOCAL_STOP_ERROR | 状态回调或本地关闭失败；原始错误被隐藏，分别记录清理状态 |

旧OpenSSH若没有可识别的完整成功诊断，可能不输出forward_ready；程序不会猜测成功或因此结束隧道。2026-11-25源码新增离线入口（旧安装包需更新）：

~~~sh
node bin/hai-bridge.mjs inspect-app --role publisher
node bin/hai-bridge.mjs inspect-app --role client --client-config /ABS/PATH/client.json --json
~~~

检查配置、公开证书期限与文件元数据；不读私钥/HAI认证，不连接ECS/HAI，不停止占用端口。B无法离线检查A实际证书，A/B分别检查；--out可独占导出安全报告。详见[离线诊断](application-inspection.md)。

## 检查现有链路

从已获准的ECS管理终端只读检查：

~~~sh
ss -ltnp 'sport = :18083'
~~~

替换为配置中实际relay_port。只有表头表示当时未观察到监听；出现127.0.0.1监听仅证明端口占用，不证明属于本次publisher或可以访问HAI。普通账号可能看不到PID；由获准管理员确认精确用户/会话/用途，不从端口号猜测归属。

B手动connect-app正在运行时，另一个终端用该真实client配置：

~~~sh
hai-bridge doctor --client-config /ABS/PATH/client.json
~~~

Windows可用hai-bridge.cmd。仅发健康与模型列表GET，不做推理；生成请求及实际工具任务另说明费用。app-tls不支持旧doctor --offline，也不允许--base-url覆盖；不要按旧配置排障页套用这些参数。

start自己拥有B连接和GET就绪流程，不需另开同端口connect-app。配置/配对目录不得作为AI工具项目目录，不分享access.json、auth.json、client.key或带认证header的curl命令。

## 停止、旧会话与安全清理

在对应publisher/start/connect-app终端Ctrl-C，只请求停止该调用自有资源，HAI不用一并停止。关闭整个窗口、Node强杀、断网/休眠不是已验证的优雅退出。当前没有后台status/stop接管命令，也不会扫描并杀同名进程。

已观察到一次A本地没有对应SSH、ECS仍有旧sshd反向监听的情况。用户管理终端确认精确会话并处理后提供空监听结果，证明该次占用清除；不能据此判定具体因开发、MDM、睡眠或某个版本造成。

只有确认是自己可结束的旧专用会话并取得相应操作授权后才处理。不要kill所有sshd、重启整个SSH服务、盲目换端口或放宽权限。重新启动后的监听属于正常运行需要，不是残留；结束后的本机状态与云端释放需分别确认。

本次可捕获路径已统一有界自有SSH清理，TERM后最多2秒、必要时KILL后再等最多1秒；超时报清理失败。父进程强杀仍不能执行finally。客户端ServerAliveInterval15/CountMax3不保证云端45秒清理。服务端ClientAlive属于另需管理员核查/授权的运维措施，也不能清除仍在线响应的本地孤儿SSH。停止状态仍明确写“云端监听是否释放尚未核验”。

## 反馈哪些信息

分享版本/提交/可信包哈希、平台/Node版本、安全状态/错误码、相关阶段和匿名端口检查结果即可。说明是助手实测、用户报告还是推测；跨设备结果与本机替身结果分开。不要发送真实token、私钥、密码、HAI认证、提示词/回复或未经检查的全量日志。
