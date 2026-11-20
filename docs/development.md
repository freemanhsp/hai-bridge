# 纯本机开发模式

独立的[应用 TLS mock 实验](application-tls-validation.md)另需 OpenSSL（支持 -addext）和 tar 来生成短期测试身份；默认 npm test 已包含该实验回归，因此运行完整源码测试也需要它们。Windows 交付包仅运行已配对的 Node/OpenSSH 探针，不要求 Windows 安装 OpenSSL。

只需 Node.js 22+，不用准备 SSH、Windows 设备、VPN 或 HAI 登录：

~~~sh
npm run dev
~~~

等价于 node bin/hai-bridge.mjs dev。默认真实 bridge 监听 127.0.0.1:18090，上游是本进程创建的随机 loopback 模拟服务，不连接真实 HAI、不读取其配置或环境凭证。该端口与历史实验 18080、真实 bridge 16656 分开。

安装本地包后，可在其他目录用 hai-bridge dev（Windows 可用 hai-bridge.cmd dev），无需源码；打印的诊断命令使用本次 Node.js/CLI 的绝对路径。见 [安装说明](installation.md)。

终端保持运行；输出会提供临时 client 配置路径及两条可复制命令。在另一个终端执行输出中的 doctor 和 probe 命令即可。doctor 应返回 mock=true、hai=not_checked；此配置的 probe --infer 只访问本机模拟服务，不调用真实模型、不计费，完成事件返回零 token 用量。

端口占用时可以自动选择空闲端口：

~~~sh
npm run dev -- --port 0
~~~

## 配置与停止

默认创建本次独有临时目录及 0600 client JSON，不读取/覆盖 .local/client.json。Ctrl-C/SIGTERM 正常停止两个自有服务、取消活动模拟流并删除自己的临时配置及空目录。异常强杀或系统崩溃可能留下临时文件；不扫描或批量删除其他临时目录。

需要保留配置时显式指定：

~~~sh
npm run dev -- --out .local/dev-client.json
~~~

显式输出在停止后保留，且拒绝覆盖任何已有文件。再次启动可以省略 --out 使用新的临时配置，或选另一个输出路径；服务不会自动改写旧配置中的端口。Windows 的 ACL 仍需用户自行确认。

配置中的 local_only=true 表示纯本机使用，connect 会拒绝启动 SSH，离线 doctor 跳过 SSH/主机信任检查。在线 client 的 HAI_BRIDGE_TOKEN 环境覆盖仍遵循原有规则：若 doctor/probe 返回 401，确认终端没有其他会话的 token 覆盖；本模拟服务本身不使用该环境变量，也不自动修改它。

## 可用模拟场景

所有 HTTP 请求仍经过真实 bridge 的 token 和路径限制。hai_bridge_public_dev_token_20261120 是公开测试占位值，不是生产凭证，不可用于真实 HAI bridge。

| 请求 | 效果 |
| --- | --- |
| GET /healthz | 实际 bridge 健康状态，仍需要测试 token |
| GET /openai/v1/models | mock=true、模型 relay-ok、请求/活动流计数 |
| POST /openai/v1/responses | 默认 stream；约每 500ms 一个固定 delta，含中文，最后 completed |
| 上述 POST 加 ?case=json | 固定模拟 JSON，不回显输入 |
| ?case=cancel | 持续模拟流直到客户端取消或服务停止 |
| ?case=429 / 503 | 原状态、mock 错误码、Retry-After: 7，无请求重放 |
| ?case=stall / disconnect | 约 5 秒 idle 504 / 上游断开 502 |

POST 只处理丢弃的输入及固定合成输出，不生成真实回复，不验证完整 AI 工具会话、compaction 或工具调用。不是通用代理；不会提供旧实验的脚本下载接口。请只发送合成测试数据。

## 机器输出与验证边界

dev --json 输出逐行 dev 事件：ready 包含本机 origin、client_config 路径和 temporary 标记，停止后输出 stopped。ready 仅证明本次两个本机监听已启动，不代表 SSH 或 HAI 就绪。错误只输出安全原因/提示，不打印原始异常或凭证。

本机自动化覆盖启动/协议/配置隔离、错误与取消、失败回收、原监听保护、停止中断及 JSON CLI。真实 Mac 新 CLI 冒烟已通过；Windows/WSL 实机、跨设备自动恢复和真实 HAI 中继仍未验证。历史 explore 资产保持不变。
