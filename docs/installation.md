# 本地安装与版本交付

首个可安装版本 hai-bridge 0.1.0，需要 Node.js 22+ 和 npm；真实中转另需 OpenSSH。没有第三方 npm 依赖，不捆绑 Node.js。package.json 保留 private=true，本流程不发布 npm、不上传 GitHub，也不复制 HAI/SSH/桥接凭证。

## 源码工作区打包

~~~sh
npm test
npm run check
npm run pack
~~~

pack 离线运行 npm，禁用生命周期脚本。每次在 .local/artifacts/hai-bridge-0.1.0-随机后缀/ 创建新目录，不覆盖旧产物，输出 archive 路径和 sha256。只交付下列三个文件，不交付整个工作区：

- hai-bridge-0.1.0.tgz：可安装包。
- SHA256SUMS：安装包 SHA-256。
- release.json：版本、Node.js 要求、SHA-256、文件清单；能查询 Git 时另记录 git_commit 和 git_dirty。

files 白名单及额外检查只允许 bin/src 运行代码、docs 正式 Markdown、README.md 和 package.json。mydocs、.local、explore、test、打包脚本、SSH 文件、环境文件不进入包。正式文档仍须确认可分享范围，白名单不是内容脱敏器。未来添加入口/许可证时，应先更新白名单和测试。

release.json 标记构建完成；失败遗留的不完整目录不要交付。git_commit 表示构建时 HEAD；git_dirty=true 表示还含未提交改动，不等同于该提交的纯净版本。正式验收宜从干净工作树打包，并核对两端相同的安装包 SHA-256；相同版本号不足以证明代码相同。

## 校验与安装

通过获准方式传输文件，并从可信发送端核对预期 SHA-256。校验只检测完整性，不是数字签名；包与校验文件同时被替换时不能证明来源。

Mac / WSL，在三个文件所在目录：

~~~sh
shasum -a 256 -c SHA256SUMS
npm install --global --offline --ignore-scripts --no-audit --no-fund ./hai-bridge-0.1.0.tgz
hai-bridge --version
hai-bridge version --json
~~~

WSL 若无 shasum，可用 sha256sum -c SHA256SUMS。Windows PowerShell，在文件所在目录：

~~~powershell
Get-FileHash .\hai-bridge-0.1.0.tgz -Algorithm SHA256
Get-Content .\SHA256SUMS
npm.cmd install --global --offline --ignore-scripts --no-audit --no-fund .\hai-bridge-0.1.0.tgz
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

默认 .local/server.json、.local/client.json、.local/publisher.json 相对当前工作目录，不相对安装目录。固定自己的工作目录，或给 --client-config / --publisher-config / --server-config 指定绝对路径；不要把配置存到安装目录。升级/重装不会自动迁移配置、接管旧 SSH 或新建 HAI 认证。真实网络仍按 [中继 CLI](relay-cli.md) 准备身份和可信主机。

## 验证边界

Mac 已通过真实离线打包、独立临时 prefix 安装、npm bin 入口、异地目录版本查询、安装后 dev→doctor→合成 SSE→SIGTERM 清理。测试未改系统全局安装、未访问真实 HAI/SSH、未停止旧服务。Windows 路径引用有自动化覆盖，但 Windows/WSL 实机安装、.cmd 入口及新中转 CLI 集中验收仍未完成。
