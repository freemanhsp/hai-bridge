# 本地安装与版本交付

当前可安装版本 hai-bridge 0.5.1，需要 Node.js 22+ 和 npm；真实中转另需 OpenSSH。没有第三方 npm 依赖，不捆绑 Node.js。package.json 保留 private=true，本流程不发布 npm、不上传 GitHub，也不复制 HAI/SSH/桥接凭证。已有真实配对的日常使用见[单命令启动](daily-start.md)。

2026-11-25：0.5.1新增 haib 短命令、use-client 原配置路径指针及 Windows 实测权限参数。已有Windows设备按[升级步骤](windows-upgrade.md)仅更新程序并选择原真实配置，设备密钥/批准和A协议不变；旧包不会自动更新。配对与程序分开交付，见[凭据说明](credentials.md)。

## 源码工作区打包

~~~sh
npm test
npm run check
npm run pack
~~~

pack 离线运行 npm，禁用生命周期脚本。每次在 .local/artifacts/hai-bridge-0.5.1-随机后缀/ 创建新目录，不覆盖旧产物，输出 archive 路径和 sha256。只交付下列三个文件，不交付整个工作区：

归档时发现Node22/npm10的目录打包会无视ignore-scripts执行prepare。现在在调用npm前拒绝pack/install生命周期hook，避免依赖此标志单独防护；正常npm run publish快捷入口保留。没有自动执行或删除用户脚本。

- hai-bridge-0.5.1.tgz：可安装包。
- SHA256SUMS：安装包 SHA-256。
- release.json：版本、Node.js 要求、SHA-256、文件清单；能查询 Git 时另记录 git_commit 和 git_dirty。

files 白名单及额外检查只允许 bin/src 运行代码、docs 正式 Markdown、README.md 和 package.json。mydocs、.local、explore、test、打包脚本、SSH 文件、环境文件不进入包。正式文档仍须确认可分享范围，白名单不是内容脱敏器。未来添加入口/许可证时，应先更新白名单和测试。

release.json 标记构建完成；失败遗留的不完整目录不要交付。git_commit 表示构建时 HEAD；git_dirty=true 表示还含未提交改动，不等同于该提交的纯净版本。正式验收宜从干净工作树打包，并核对两端相同的安装包 SHA-256；相同版本号不足以证明代码相同。

## 校验与安装

通过获准方式传输文件，并从可信发送端核对预期 SHA-256。校验只检测完整性，不是数字签名；包与校验文件同时被替换时不能证明来源。

Mac / WSL，在三个文件所在目录：

~~~sh
shasum -a 256 -c SHA256SUMS
npm install --global --offline --ignore-scripts --no-audit --no-fund ./hai-bridge-0.5.1.tgz
hai-bridge --version
hai-bridge version --json
~~~

WSL 若无 shasum，可用 sha256sum -c SHA256SUMS。Windows PowerShell，在文件所在目录：

~~~powershell
Get-FileHash .\hai-bridge-0.5.1.tgz -Algorithm SHA256
Get-Content .\SHA256SUMS
npm.cmd install --global --offline --ignore-scripts --no-audit --no-fund .\hai-bridge-0.5.1.tgz
hai-bridge.cmd --version
hai-bridge.cmd version --json
~~~

Windows 两条校验命令需人工比较哈希，大小写可忽略；不匹配时停止安装。若 PowerShell 拒绝 npm.ps1/hai-bridge.ps1，使用 .cmd，不需要改全局执行策略。不要用 npm install -g hai-bridge 或 npx hai-bridge 寻找同名公开包，本项目未发布到 npm。

全局安装会更新当前 npm prefix 中已有的同名包。需隔离或遇到 Mac 全局权限问题时，为本次安装附加 --prefix 一个全新、自有的目录，再显式调用该目录下的 bin/hai-bridge（Mac/WSL）或 hai-bridge.cmd（Windows）；不必 sudo，不改全局 npm prefix 配置。命令未找到时核对 npm prefix -g 和 PATH；Windows 重开终端可能有帮助。

Windows 与 WSL 的 Node.js/npm/安装目录独立，不复用 Windows 安装或 SSH 身份。卸载用 npm uninstall --global hai-bridge，自定义安装带同一个 --prefix；只移除程序，不删除外部配置、密钥或配对文件。

## 安装后使用

无需克隆仓库：

~~~sh
hai-bridge dev --port 0
~~~

Windows 可用 hai-bridge.cmd dev --port 0。启动输出的 doctor/probe 命令指向本次 Node.js/CLI，安全引用含空格/引号的路径，可在其他目录执行。Ctrl-C 清理本次临时配置；只有合成输出，不计费，不验证完整 AI 工具会话。

现有文档的 node bin/hai-bridge.mjs COMMAND，在安装后可换成 hai-bridge COMMAND（或 hai-bridge.cmd COMMAND）。源码命令仍有效。npm run dev、npm test、npm run pack 是源码入口，不是在任意目录使用的全局命令。

源码新增 npm run setup:publisher -- --server-config PATH 和 npm run publish；安装后的对应入口仍是 hai-bridge setup-publisher / hai-bridge publish-app。不会静默改用旧CLI的publish（历史Mac SSH22转发）。

旧命令默认 .local/server.json、.local/client.json、.local/publisher.json 相对当前工作目录，不相对安装目录。固定自己的工作目录，或给 --client-config / --publisher-config / --server-config 指定绝对路径；不要把配置存到安装目录。0.5.1 的 use-client 显式保存已有真实配置的路径，start/haib 优先读取此指针；没有指针时兼容 setup-client 创建的 ~/.hai-bridge/client.json。setup-client 不覆盖旧默认；use-client 不复制身份，原路径须保留。setup-publisher 只记录原 A 配置路径。升级/重装本身不会自动迁移配置、接管旧 SSH 或新建 HAI 认证。当前真实网络按 [真实 HAI](real-hai.md) 使用应用 mTLS 与出站 ECS SSH，不依赖历史 Mac 系统登录。

## 验证边界

0.5.1最终Node22/24均213/213回归通过，原212项候选构建结果保留；[验证记录](validation.md)另记npm hook防护和LibreSSL夹具修正。用户已有Windows真实Codex读写/4项测试和临时函数交互成功反馈；新包入口仍待Windows验收。此次按用户要求分批本地commit，不推送。首个候选包的git_dirty=true是当时状态，保留原包；提交后新构建另记提交/哈希。

以下为早期安装验证记录。Windows 随后已提供0.4.0私有交付/真实HAI5/5报告，但0.5.0全局安装、单命令start、Windows Ctrl-C进程树及WSL仍待新版本实机反馈。0.5.0本机已用独立prefix离线安装，再导入稳定配对、离开源码目录执行真实CLI start；使用合成HAI/SSH/Codex，不等同真实工具验收。

Mac 已通过真实离线打包、独立临时 prefix 安装、npm bin 入口、异地目录版本查询、安装后 dev→doctor→合成 SSE→SIGTERM 清理。这些早期测试未改系统全局安装、未访问真实 HAI/SSH、未停止旧服务。Windows路径引用有自动化覆盖，0.4.0私有试用另有成功报告；0.5.0新版日常封装/.cmd入口/真实Ctrl-C进程树和WSL仍未取得实机验收，不继承旧版本结果。
