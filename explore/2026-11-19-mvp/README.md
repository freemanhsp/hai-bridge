# 首个 MVP 验证

日期：2026-11-19。验证机器：Mac A；HAI 1.4.9、Node.js 24.14.0、Codex 0.163.0。

验证路径：本机客户端使用桥接 token → A 的 bridge 16656 → A 的 HAI 6655 → 公司模型平台。HAI key 留在 A。

14 项本机模拟集成检查通过。真实 `doctor` 返回 bridge/HAI ok，14 个模型。真实流式 probe 返回 200、completed、2 字符，11 input + 5 output tokens。真实 Codex 任务明确显示 provider hai-bridge，最终输出 OK，退出 0，报告 tokens used 10,556。

## Codex exec 参数兼容性

初始启动器将 provider `-c` 放在根命令位置。测试使用 `--no-daemon exec --ignore-user-config` 时，本机版本没有应用这些配置，显示 provider openai，默认端点连接失败；测试已停止。

将覆盖参数放到 exec 子命令后，保留用户的子命令选项，随后通过 strict-config 和真实 HAI 推理验证。入口现在对 exec、review、resume、fork 等子命令采用子命令后的参数注入；已为 exec 加入回归断言。其他高级子命令没有逐个做真实模型验证。

通过工具运行 Codex exec 时，未连接终端的 stdin 会被视为待追加输入；最终测试使用真实终端，避免等待 stdin EOF。用户在 PowerShell / WSL 终端运行不需要额外步骤，正常管道输入则保持原有行为。

Windows 原生、WSL、真实 SSH 链路及异地连通尚未验证。没有将本机模拟标记为 B 设备实测。
