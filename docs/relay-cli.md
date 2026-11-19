# ECS 中继 CLI

这是手工双层 SSH 的前台封装，不是新的代理协议。当前跨 ECS 验证仅使用模拟上游；真实 HAI 中继要先确认该具体网络路径的授权。

```text
Mac A: publish → ECS:127.0.0.1:18083 → Mac A:127.0.0.1:22
B: connect → 经 ECS 的内层 SSH（终止于 Mac）
B:127.0.0.1:18084 → Mac A:127.0.0.1:18080 → 模拟上游
```

ECS 是 SSH 字节中继，内层 SSH 的主机密钥校验及解密发生在 B 和 Mac；不把 HAI HTTP 端口直接反向发布到 ECS。但这不替代平台/公司对网络路径的授权。

## 启动前

- 两端都有 Node.js 22+、OpenSSH 和同一版本的项目代码。下列命令在项目目录运行，无第三方 npm 依赖。
- Mac 已开启远程登录；A→ECS、B→ECS、B→Mac 分别已授权公钥。ECS 使用独立非 root 账号，示例为 `hai-publisher` 和 `hai-jump`。
- ECS 和 Mac 的主机指纹已经通过可信渠道核对。B 的 known_hosts 还需信任 `hai-bridge-mac` 别名；工具不会自动接受未知或变化的主机密钥。
- ECS 的 SSH 服务必须限制反向监听到 loopback（如 `GatewayPorts no`），并核对实际监听地址。CLI 请求 loopback，不能替代服务端约束。不要开放 18080/18083/18084 公网入口。
- 同端口迁移时，先在原来的专用终端 Ctrl-C 停止旧手工 SSH，再启动新命令；工具不接管或杀掉其他进程。模拟服务已运行时不要重复启动它。

`ECS_HOST` 和 `MAC_USER` 是占位符，替换成已验证的公网主机和 Mac 登录用户名。私钥只由本机 SSH 使用，不传到另一台电脑。

## Mac：发布 SSH

首次初始化（`.local/ecs_known_hosts` 需预先存在且已核对 ECS 指纹）：

```sh
node bin/hai-bridge.mjs init-publisher --ssh-target hai-publisher@ECS_HOST --identity-file ~/.ssh/hai_ecs_a --known-hosts-file .local/ecs_known_hosts
```

终端一，保持运行：

```sh
node bin/hai-bridge.mjs publish
```

终端二，仅在模拟服务未运行时启动：

```sh
node explore/2026-11-19-ecs-relay/mock-relay.mjs
```

`publish` 只转发 Mac SSH 22，不启动 bridge、模拟服务或 HAI，不读取 HAI/配对凭证。默认 publisher 配置 `.local/publisher.json`；用 `--publisher-config PATH` 可选独立配置，`--relay-port PORT` 仅在初始化时改变 ECS 的反向端口。

## Windows 11：生成配置并连接

首次初始化，使用 Windows 自己的两个私钥；已有验证可复用其已核对的默认 known_hosts：

```powershell
node bin/hai-bridge.mjs init-relay-client --mock --relay-target hai-jump@ECS_HOST --mac-user MAC_USER --relay-identity-file "$env:USERPROFILE/.ssh/hai_ecs_b" --identity-file "$env:USERPROFILE/.ssh/hai_mac_b" --out .local/relay-mock.json
```

生成两份文件，初始化拒绝覆盖已有内容：

- `.local/relay-mock.json`：模拟 token、端口、模型和 SSH 配置路径。
- `.local/relay-mock.json.ssh_config`：独立跳板/Mac 配置和各自的密钥路径，不含私钥内容；不修改全局 SSH config。

终端一，保持运行：

```powershell
node bin/hai-bridge.mjs connect --client-config .local/relay-mock.json
```

终端二，检查链路：

```powershell
node bin/hai-bridge.mjs doctor --client-config .local/relay-mock.json
```

模拟服务的预期输出：

```json
{
  "bridge": "ok",
  "hai": "not_checked",
  "mock": true,
  "model_count": 1,
  "configured_model_available": true
}
```

`doctor` 只发健康/模型列表 GET，不生成模型回复。这里 `hai: not_checked` 明确表示没有验证真实 HAI；即使真实配置返回 `hai: ok`，也仅证明模型列表可读，不证明生成资格或全部模型可用。`Starting SSH` 日志只表示启动尝试，不能作为连接就绪信号；以 `doctor` 为准。

默认 B 18084→Mac 18080、ECS SSH 中继 18083。两端初始化时 `--relay-port` 必须一致；`--local-port` 可避免 B 的端口冲突，`--ssh-port` 指 ECS SSH 入口端口。`--known-hosts-file PATH` 可指定已核对的专用信任文件，需同时包含 ECS 与 Mac 别名记录，不能直接使用只含 ECS 的文件。

## WSL

命令逻辑相同，但在 WSL 中独立安装 Node.js、SSH，准备自己的公钥授权、私钥/agent 和 known_hosts；不要复制 Mac 私钥，也不要假定 Windows 的 SSH agent、信任文件及 localhost 能直接复用。私钥放在 WSL 自己的 Linux 文件系统并限制权限。

初始化时改用 WSL 的密钥路径，并可加 `--local-port 18086`，避免与 Windows 同时运行时冲突。在 WSL 内运行 `connect`、`doctor`。WSL 端到端尚未实测。

## 停止与恢复

在运行 `publish` 或 `connect` 的终端按 Ctrl-C：停止该命令拥有的 SSH 子进程并退出；不会停止另一端、模拟服务、HAI 或其他手工 SSH。再次运行同一命令才会重新启动。当前没有后台服务、PID 文件、`up/down/status` 或开机自启动。

当 SSH 退出被归类为连接故障时，默认最多连续重试 5 次，等待 1、2、4、8、15 秒；运行满 30 秒的 SSH 进程会重置连续失败预算。30 秒是进程存活启发式，不是链路健康证明，也不是总重试次数限制。两端均需自己的命令仍在运行，才能分别恢复。

SSH 退出被归类为认证、指纹、配置、转发冲突或转发拒绝时停止，不盲目重试。部分目标转发拒绝只在实际 HTTP 请求时出现，不会让 SSH 进程退出，需用 `doctor` 排查。日志只输出分类，不打印原始服务端 stderr；需要时手工运行 SSH 查看详细诊断，不降低主机校验。

重连只修复传输，不重放已发送的模型请求；在途生成会失败，由调用方决定是否重新发起。Ctrl-C 主动停止不会触发自动重连。

## 真实配置入口（待授权后使用）

只在确认真实 HAI 经该 ECS 路径获准后，使用已有私密配对文件代替 `--mock`：

```sh
node bin/hai-bridge.mjs init-relay-client --pairing-file .local/paired.json --relay-target hai-jump@ECS_HOST --mac-user MAC_USER --relay-identity-file /path/to/b-ecs-key --identity-file /path/to/b-mac-key --out .local/relay-real.json
```

该入口导入独立 bridge token、端口和模型，不复制 HAI key/SSO，不发模型请求。真实配对文件及新 client JSON 都必须保密。Mac 改为运行正常 `serve`，但 publisher 的 SSH 中继不变；Mac 公钥的 `permitopen` 也必须允许真实 bridge 的目标端口，当前仅允许模拟 18080 的配置不能直接用于 16656。实际生成和计费需另行说明并验证。

## 目前验证状态

本机配置生成、SSH 参数与失败分类/退避/取消有自动化覆盖；Mac 新 `publish` 的真实 SSH 反向发布与 Ctrl-C 清理已实测。旧手工 Windows 链路的模拟脚本有用户报告 11 PASS。**新封装的 Windows/WSL 全链路及实际自动断线恢复尚未验证**，不能继承旧手工链路结论。

下一轮集中验证见 [推进计划](roadmap.md)。
