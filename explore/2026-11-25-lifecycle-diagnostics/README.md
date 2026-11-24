# 本机生命周期与离线诊断

以下为158项本机批次的历史快照，“尚未提交/验收”指当时状态；后续分批提交、213项回归与Windows用户实战反馈见[当前验证记录](../../docs/validation.md)。JSON原报告保留不改写。

2026-11-25，起点0.5.0 / fe3633f，工作区改动尚未提交。新增回归纳入test/，不重复复制正式实现。安全摘要见[results-local.json](results-local.json)，为助手整理结果，不是原始stdout或Windows/ECS实测。

旧runTunnel在最小合成forward_ready observer异常复现中出现异步异常和等待不结束；该测试只使用EventEmitter子进程替身，没有真实SSH。核实后只终止该Node测试的父/子进程。新增用例设置超时，新实现捕获observer异常后停止自己的child。

本机npm test最终158/158（基线137，新增21）通过，npm run check与模块语法通过。SSH是EventEmitter/TCP/CLI替身，HAI为合成loopback上游；生成的测试密钥只在临时目录，私密fixture不进入此摘要。生命周期测试包括TERM→KILL→有界失败、重复信号、已exit不再kill、close/error、异步rejection、旧attempt竞争和应用/会话清理。离线诊断测试限制读取白名单，覆盖期限/错配/权限/端口保护/安全输出。

没有实际ECS/HAI或模型请求，不修改个人默认项、公司策略或真实配对。公开证书检查不证明私钥匹配、token/HAI认证有效；注入Windows分支不证明Windows实机。父进程SIGKILL与远端半开只记录限制，没有新增守护/云端运维或现场故障实验。

尚未检查：新版Windows/WSL、真实A外层恢复与ECS释放、VPN/休眠、实际工具任务、长期稳定性。历史132/137项和Windows报告保持不变。
