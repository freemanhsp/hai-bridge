# 最小真实 HAI 应用接入资产

local-smoke.mjs 只验证 Mac 上的 B 客户端适配器 → A 双向 TLS bridge → A HAI，不代表 Windows/WSL 或 ECS 端到端。需要先用专用真实配对启动 publish-app。默认只查模型列表；--infer 明确发送一次计费的固定短流式请求，不重试，不打印认证或模型正文。

    node explore/2026-11-20-hai-app/local-smoke.mjs --server-config /PATH/server.json --out NEW_SAFE_REPORT.json --infer

仅保存无敏感内容的阶段/计费用量报告；身份/配置/包放 .local，不纳入 Git。Windows 单独使用 scripts/windows-hai-trial.ps1 / try-hai，完整报告收到后另存，不继承本机成功标签。

## Windows 真实调用用户报告

用户提交完整 JSON，字段和值语义不变归档为 [results-windows-user.json](results-windows-user.json)。版本0.4.0、win32、Node24.22.3、application-cli-real-HAI-B-ECS-A、mock=false，5/5 pass：固定指纹双向 TLS 就绪、真实模型列表、Responses流式完成、结束后自有HTTP及TLS隧道端口释放。14个模型、配置模型可用，报告用量input11/output5 tokens。

这是用户提供的跨设备报告，非助手直接在 Windows 执行；原 JSON 未含执行时间、包哈希或原始SSH事件，不补造。Mac本机报告保留自己的证据类型，计费用量相同不代表两份报告是同一次请求。用户同时提供的配置仅用于判读mode/role/端口，不另保存其个人路径或凭证。

尚未验证实际AI工具读写任务、WSL、A外层恢复、VPN/休眠或长期稳定性。后续直接用既有真实client启动connect-app，在Windows无敏感测试项目运行工具，避免重复发送已通过的API探针。本次归档未新发模型请求。

后续用户按启动说明操作，Mac重复publisher启动失败。助手只读确认此前自有进程占用18081、使用同一配置且mTLS健康GET返回200，没有模型请求或进程变更。用户随后反馈“好的成功了”，记录为启动流程成功的用户反馈；未提供Codex任务、工具读写或测试输出，不将该反馈补写为完整工具任务验收。下一批改进启动易用性，避免反复找路径和手动维护两终端。
