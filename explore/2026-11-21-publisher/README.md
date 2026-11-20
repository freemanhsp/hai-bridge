# Publisher快捷启动与状态回归

代码提交7236950，0.5.0。本批加npm setup:publisher/publish入口、中文状态与OpenSSH预期转发元组的forward_ready诊断；另修正CLI拒绝测试使用临时profile-dir，避免读取个人默认项。

results-local.json为助手根据实际最终npm test/npm run check结果整理的安全汇总，不是原始stdout。新增5项后137/137通过；独立保留此前session132项与Windows原报告，不把本机替身作为跨设备验收。

最终回归仅用本地合成上游、真实mTLS、本地TCP转发及SSH/Codex子进程替身、临时私有配置与离线安装，不发送真实模型请求。提交前另一次重跑暴露缺省profile测试误启动自有真实publisher；已停止该测试子进程并只读确认ECS监听释放，再修正/重跑。该观察单独记录，不升级为异常断链恢复证据。

forward_ready是尽力匹配OpenSSH诊断，不是安全校验或B→HAI就绪。Windows/WSL实机、完整工具任务、A异常/休眠恢复、设备登记/自动续期尚未验证或实现。操作见docs/daily-start.md，后续见docs/next-development.md。
