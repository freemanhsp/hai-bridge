# 2026-11-19：HAI 转发可行性

问题：已认证的 Mac 上，额外增加一个 HTTP 转发进程，是否会被 HAI 拒绝？是否能正确返回 Responses 流式内容？

环境：Mac，HAI 1.4.9，Node.js 24.14.0。上游为 `127.0.0.1:6655`，临时中转也只监听 loopback。

| 实验 | 结果 |
| --- | --- |
| 无 key / 错误 key，直接请求模型列表 | 401 |
| 正确 key，直接请求模型列表 | 200，14 个模型 |
| 无 key，经中转请求模型列表 | 401 |
| 正确 key，经中转请求模型列表 | 200 |
| 不同 Host 或转发头，经中转请求模型列表 | 200 |
| 直接 Responses / SSE | 200，9 个事件，completed |
| 经中转 Responses / SSE | 200，9 个事件，completed |

两次实际生成使用 `gpt-6-luna`，每次 11 input + 5 output tokens，合计 32 tokens。临时中转在实验结束关闭。

结论：当前 HAI 可以接受 A 本机的额外 HTTP 转发，并完成真实流式生成。没有发现测试涉及的 Host / Origin / X-Forwarded-For 检查会拒绝模型列表请求。不能由此排除后台其他设备策略，亦未验证 B 跨设备网络。

CLI 源码链接返回 404，当前账号可访问的组织仓库列表未显示 hai-cli，未完成源码审计。

`probe.mjs` 为模型列表与认证实验；`stream-probe.mjs` 会发送两次极短的计费模型请求。归档时仅将原脚本中的机器专属 auth 路径改为当前用户 home 路径。脚本不会打印 key，凭证在进程内从 `.codex/auth.json` 读取。它们保留早期实验实现，不代表正式桥接功能。

相关背景文档：

- [架构](https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/concepts/architecture/)
- [SSH 隧道](https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/guides/ssh-tunneling/)
- [API 端点](https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/configuration/api-endpoints/)
- [Codex 配置](https://ai-docs.portal.hyperspace.tools.sap/llm-proxy/recipes/codex/)

用户说明已经针对实际特殊场景与 HAI 团队对齐。通用文档与该授权的差异不作为推断全部用户都可使用的依据。
