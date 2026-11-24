# Windows 实战与启动器封装证据

来源分别为用户提供的终端日志/文字反馈及助手本机合成回归。没有保存原提示词/回复、设备指纹、配置内容、私钥或真实认证。下面是整理摘要，不是原始 stdout。

## 用户实测（0.5.0 clockfix 程序，Windows 原生）

- Codex0.171.0、Node24.22.3、win32、provider hai-bridge；模型调用沿已批准的真实v2链路。
- 原完整 acceptance 失败：有效 sandbox 显示read-only，工具读取命令被策略拒绝；保留原FAIL，不将后来成功改写成整批通过。
- 不调用模型的MXC / managed workspace检查可读取合成源文件，创建/删除自有临时文件。
- 显式--sandbox workspace-write与windows.sandbox="mxc"的真实任务读取本地文件，仅修复src/sum.mjs，模型中4项测试通过。
- 再次任务读取已修复文件，不改文件；最后用户独立正确运行4/4测试通过。一次独立命令曾因粘贴粘连而MODULE_NOT_FOUND，后已纠正。
- 用户最新回复“测试过了没问题”，指此前临时PowerShell haib函数的交互启动。不是新0.5.1安装入口验收。

## 助手本机（0.5.1候选构建，历史）

212/212 npm test、npm run check通过；临时配置/密钥/回环服务器、TCP SSH与Codex替身，没有真实HAI/ECS调用。覆盖Windows默认参数/exec位置、其他平台无Windows键、显式只读/权限/backend保留、原配置指针/旧默认/身份保护、坏指针fail-closed、实际离线包/独立prefix安装/haib入口/正常退出/端口释放。首轮受限环境listen EPERM失败，获准本机回环环境重跑通过。

官方OpenAI Docs访问403，不能据此宣称当前官方支持范围；Windows参数依据用户实测，Mac CLI解析仅作本机参考。未commit/push；候选包git_dirty记录工作区，不冒充已提交发布。

## 分批归档与最终源码回归

代码已按自有清理、打包hook防护、设备认证/诊断、集中验收、0.5.1短入口五批提交，文档/证据另批归档；不推送。各索引快照独立验证，最终Node22.22.2/npm10.9.7/LibreSSL3.3.6与Node24.14.0/npm11.9.0/OpenSSL3.6.4均213/213，无跳过，npm run check和53个模块语法检查通过。[安全摘要与批次](results-commits-local.json)。这些是助手整理的本机结果，不是Windows实机或原始stdout。

npm10发现ignore-scripts无法阻止目录prepare；打包脚本改为调用npm前拒绝8种pack/install hook，正常npm run publish不受影响。LibreSSL不支持测试用-days 0，改为临时CA签发明确过去日期的叶证书并断言过期，不改运行时验证。最初受限环境的回环EPERM和随后获准重跑分别记录。

首个候选包保留原SHA-256与dirty状态，文档提交后干净构建另有release.json；不覆盖旧产物。升级只更新程序，现有真实设备不重新邀请/登记/审批，不要求重复计费任务。

## 未验证

新包Windows安装/haib.cmd；原完整脚本更新后整批结果；自动无模型工具权限预检；真实Ctrl-C、A外链/根轮换/撤销传播、VPN/睡眠、Windows ACL、WSL/Linux/macOS B及长期稳定性。
