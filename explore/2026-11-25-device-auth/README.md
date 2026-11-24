# 个人设备认证 v2 本机证据

本页及JSON保留各批当时状态，不改写历史176/183项报告。后续Windows真实工具成功反馈与当前分批提交/213项回归见[最新安全摘要](../2026-11-25-windows-launcher/README.md)及[验证记录](../../docs/validation.md)。

## 双机时间差修复补充（历史）

用户已实机登记/批准，首次集中检查失败。diagnostic-windows-user-clock-skew.json 保留用户提供的诊断原文：TLS verified、challenge200、expires_in_ms121853超过旧B的120000上界、local models503、自有两端口释放；没有会话/协议通过结果。报告没有执行时间/包哈希，不补造；Date秒精度估计不是准确校时值。

results-clockfix-local.json 是助手整理的修复后本机摘要，不是Windows报告或原始stdout。新增7项后默认183/183；其中4项新回归先在旧实现失败。B改用固定TLS peer的HTTP Date/耗时与双相对时钟，A签名/期限/身份不变。修复后Windows15项、实际睡眠/VPN、WSL/真实HAI仍未验收。

## 初始本机批次（历史快照）

2026-11-25。助手整理的合成测试摘要，不是Windows/WSL/ECS或真实HAI结果，不保存测试身份、私钥或回复。

源码独立schema2/app-device，旧v1和上一批P0工作保留。默认npm test176/176（原158 + 新18），npm run check和所有mjs语法检查通过。v2新增回归在test/device.test.mjs；集中入口src/device-checks.mjs与scripts/windows-device-checks.ps1。本机TCP SSH替身下B批量15/15通过；Windows脚本未实机运行。

实际本机TLS与合成上游验证设备登记/签名/撤销、短会话刷新、A服务器证书续订、重启不重放、协议与清理。最初受限环境禁止loopback（EPERM），仅开放临时合成测试运行权限后通过；没有因此连接真实服务。开发过程修正测试net.Server清理兼容性，失败测试不计作最终通过。

没有启动真实publisher、修改VPN/sshd/安全组、读取/迁移个人HAI凭据或提交/推送。普通包/临时prefix测试不代表已交付新包。根信任仍需手动更新；Windows ACL、跨设备E2E、真实HAI/工具任务、VPN/睡眠与长期稳定性待验收。旧历史报告不改写。
