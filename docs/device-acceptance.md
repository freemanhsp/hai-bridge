# v2 一次集中验收与 Codex 实战

2026-11-25：首次 Windows 完整脚本运行在工具任务阶段失败，Codex 显示 read-only 且命令被策略拒绝；原 FAIL 保留。随后用户使用显式 workspace-write + MXC 成功修复本地文件并独立通过4/4测试，又反馈临时 haib 交互启动正常。不能将这些后续通过改写为原脚本全 PASS。0.5.1 与本脚本现在封装同样参数；最终本机 Node22/24 均213/213通过，新包/更新脚本仍待 Windows 验收。已完成真实登记和实战的设备优先[程序升级](windows-upgrade.md)，不必重复本篇收费验收。

## 准备

无需重新安装 Bridge，也不安装 Windows SSH 服务或启用 Mac Remote Login。B 需要 Node.js 22+、现有 OpenSSH 出站公钥配置和 Codex；Codex 缺失时可自行执行 `npm.cmd install --global @openai/codex`。脚本不会自动安装软件或关闭 sandbox。官方 Codex 文档访问受限，先用 B 实际安装的 CLI 执行无推理 `exec --help` 验证所用选项兼容性。

只把仓库的 `scripts/device-acceptance.mjs` 一个小文件复制到 Windows，例如 `F:\codes\hai-bridge-clockfix\device-acceptance.mjs`。它通过 `--cli` 定位已有安装的源码模块，不依赖同目录的仓库文件，因此无需传新 tgz。

默认沿用本次已经交付的布局：

- 程序：`%USERPROFILE%\.hai-bridge-v2-mock\runtime-clockfix\node_modules\hai-bridge\bin\hai-bridge.mjs`。
- 旧 MOCK 身份：`%USERPROFILE%\.hai-bridge-v2-mock\client.json`，不重建或修改。
- 新真实身份：`%USERPROFILE%\.hai-bridge-v2-hai\client.json`；已有则复用，不覆盖。
- 新邀请接收位置：`%USERPROFILE%\.hai-bridge-v2-hai\invite-windows.json`。
- SSH 目标、key、known_hosts 和中继端口沿用 MOCK 配置；不新增网络路径。

自定义位置用 `--cli`、`--mock-config`、`--client-config`、`--invitation` 指定。真实身份必须是独立 app-device / hai，并仍使用同一个中继目标/SSH 端口/relay 端口。新的真实实例需要邀请和批准，不能把 MOCK 改模式。

## 一次启动，两个配对暂停点

先保持 A **MOCK** publisher 运行，停止自己之前的 B connect-app/start（Ctrl-C），不要同时占用 B 18084/18085。

Windows 普通 PowerShell：

~~~powershell
cd F:\codes\hai-bridge-clockfix
node .\device-acceptance.mjs --project-root F:\codes --renewal
~~~

`--renewal` 增加约12分钟，每分钟读取一次模型列表，跨越10分钟短期会话周期；不额外发推理请求。只需快速实战时可以省略，报告会保留 session_continuity 未验证。

自动先检查 Codex 参数兼容和15项 MOCK。成功后：

1. **PAUSE 1**：在 A 原 MOCK publisher 终端 Ctrl-C，只停止 Bridge，不停止公司 VPN/HAI。然后在 Mac 仓库运行：

   ~~~sh
   cd /Users/I605103/codes/hai-tool
   node scripts/prepare-device-hai.mjs \
     --from-server-config .local/hai-app/app-tls-wkPZGj/server.json \
     --model gpt-6.1-sol
   ~~~

   该辅助脚本只读取旧真实配置的元数据，保留 HAI auth 文件引用及现有 SSH/中继配置，不读取/导出旧 HAI key 来迁移、不改旧配置。它创建独立真实 v2 实例、15分钟一次性邀请并启动前台 publisher。打印 `A_CONFIG`、`PRIVATE_INVITATION`、完整批准命令和日后重启命令。端口被占用则停止，绝不杀掉旧进程。

   把 `PRIVATE_INVITATION` 指向的**那一个文件**私下复制到 Windows 的 `%USERPROFILE%\.hai-bridge-v2-hai\invite-windows.json`，不要传 `.local` 整个目录、SSH key 或 auth.json，也不要上传到公开 GitHub。Windows 脚本打印绝对接收路径；它已创建父目录。保持新 Mac publisher 终端打开，Windows 按 Enter，脚本自动生成 B 私钥并登记。

2. **PAUSE 2**：Windows 打印新的完整64位设备指纹。在 **第二个 Mac 终端**运行辅助脚本已打印的批准命令，粘贴这个指纹；检查批准的是相同完整指纹。不能按标签批准，不用旧 MOCK 指纹。看到 `approved saved` 后回 Windows 按 Enter。

随后输入 **RUN** 明确同意计费，再让脚本自动完成；其他输入会停止且不发模型请求。

## 自动完成的真实验证

- 固定 TLS/设备会话与真实 HAI 模型列表，确保配置模型可用，不可用则拒绝推理。
- 一次小额度 Responses SSE 探针，只记录完成状态和 token 数；不打印回复。真实调用会计费，不自动重放 POST。
- 可选12分钟模型列表连续可用检查，不宣称记录了每一次内部会话续订细节。
- 自动创建 B 本地独立 `hai-bridge-practice-*` 项目；不会修改用户原项目。包含4项测试，初始应1通过、3失败。
- 真实 `start` 的 `exec --help` 启动/正常退出与端口释放检查；这一步不发模型推理请求。
- 通过 `start` 启动 Codex 修复本地 `src/sum.mjs` 并运行测试。这是实战，会产生多个模型请求，费用不以64-token探针上限为限。
- 重新独立执行4项本地测试，要求全通过；比对测试文件/环境证据文件 SHA-256，不允许通过改测试伪造成功。
- 自动关闭每阶段自己启动的 HTTP/SSH/Codex，复核 B HTTP/TLS tunnel 端口可绑定。保留测试项目便于查看。

脚本显式将 --sandbox workspace-write 及 Windows 的 windows.sandbox="mxc" 放到 exec 参数中，因此原 clockfix 程序也可复用；不改全局 Codex 配置或忽略管理策略。exec 的有效审批行为以 Codex 实际输出为准，不保证 on-request；Windows 成功日志为 approval: never。任务只提供合成内容，不额外强制项目外读取隔离；凭据不写入项目或报告，Codex 输出仅显示在终端。help 预检仅证明参数可解析，不证明工具读写权限。

## 结果、失败与重跑

结束打印 `Acceptance: PASS` 和 `Safe report: ...`。脱敏报告默认保存在真实 client.json 同级的 `results/acceptance-*.json`，附带 MOCK 子报告。可回传汇总 JSON，不要回传邀请、identity.json、私钥或整个配置目录。报告区分成功/失败/用户取消/中断；保存安全的阶段名、受限错误类别/HTTP 状态及推理统计，不保存原异常或上游正文。

失败后不继续后续阶段、不自动重发推理，不杀无关监听。已有身份/配置保留，修复原因后可重跑；如果 A 已经是真实 publisher，使用：

~~~powershell
node .\device-acceptance.mjs --project-root F:\codes --skip-mock --renewal
~~~

此时不会创建新身份或邀请；未完成登记且内部邀请仍有效时尝试用原 key 完成登记。若邀请已过期且未完成登记，需要单独恢复配对；脚本不会替换信任/私钥强行修复。重跑真实阶段仍会要求 RUN，可能再次计费，不应无脑循环。

**Mac 初始化辅助脚本只用于第一次创建新实例，不要每次重跑都重新初始化 A。** 用第一次打印的 `Restart later` / `publish-app --server-config` 重启同一实例，否则原 B 信任会失配。正在运行的 A publisher 保持 ECS 18083 监听是预期，不代表云端残留；此脚本仅核验 B 自有资源，不宣称核验了云端监听释放。

尚不覆盖：A 撤销实机传播、真实叶证书续签、A 外链中断/恢复、VPN/睡眠恢复、Windows ACL、未实际运行过的 WSL/其他 B 系统、长期稳定性。故障注入不与正在计费的模型任务混跑。其他系统应单独登记自己的设备密钥，不复制 Windows 身份冒充已验证。
