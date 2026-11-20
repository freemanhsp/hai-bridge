# 0.5.0 日常启动回归

本批先提交已有0.4.0实战代码与证据，再实现个人稳定配置和单命令start；设计草稿位于不进入Git的mydocs。网络仍为既有应用mTLS/双方出站ECS SSH，不使用Mac系统登录，不改变公司VPN或云端权限。

results-local.json是2026-11-21助手执行npm test/npm run check后的安全汇总，不是原始测试stdout，也不包含Windows实机结果。16项新session回归加既有116项，共132/132通过。src/bin/scripts/test共36个.mjs语法检查通过。

测试使用合成HAI、真实mTLS及自有loopback TCP传输替身、合成Codex；离线普通包安装后执行setup-client/start也用替身。没有真实模型POST；不继承0.4.0真实跨设备报告。Windows进程树是注入测试，PowerShell集中脚本未运行，WSL/实际Codex任务/外层及休眠恢复仍待证据。

可重跑npm test、npm run check。新增Windows集中脚本位于scripts/windows-session-checks.ps1，使用普通无身份runtime.tgz和旧私有配对，详见docs/daily-start.md；该脚本不生成模型回复、不重跑历史故障注入。
