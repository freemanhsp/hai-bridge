# 已登记 Windows：升级到 0.5.1

此次只升级程序、明确选择已有真实 v2 配置。无需重新邀请、生成设备密钥、A 审批或修改 Codex 全局配置；A 既有服务保持运行即可。原 clockfix 安装保留作回退，新版增加持久 haib.cmd。

## 需要传什么

只传普通 hai-bridge-0.5.1.tgz、SHA256SUMS 和 release.json。不传配置、device 目录、SSH 密钥、A 认证或整个工作区。包不含凭据，正式文档可能包含既有架构/网络信息，仍需遵守分享范围。

首个0.5.1候选包在提交前生成，git_dirty=true保留不改写。本轮按用户要求分批本地commit，不推送；干净提交的新构建会有自己的SHA-256与release.json，不覆盖旧包。核对你实际收到的包，不混用不同构建的校验值。

## 一次完成校验、安装与配置选择

先在自己的终端 Ctrl-C 停掉旧 B 会话/connect-app。普通 PowerShell，不需管理员。在下载目录执行下面**整个脚本块**；把预期哈希替换为 Mac 可信发送端提供的64位值，不能只信同目录校验文件。

~~~powershell
& {
    $ErrorActionPreference = 'Stop'
    $haiArchive = (Resolve-Path -LiteralPath '.\hai-bridge-0.5.1.tgz').Path
    $haiExpectedHash = '替换为可信发送端提供的64位SHA256'
    if ($haiExpectedHash -notmatch '^[a-fA-F0-9]{64}$') { throw '先填写可信预期哈希。' }
    if ((Get-FileHash -LiteralPath $haiArchive -Algorithm SHA256).Hash -ne $haiExpectedHash) {
        throw '安装包哈希不匹配，未安装。'
    }
    $haiConfig = Join-Path $env:USERPROFILE '.hai-bridge-v2-hai\client.json'
    if (-not (Test-Path -LiteralPath $haiConfig -PathType Leaf)) { throw '找不到原配置，请勿重新初始化。' }
    $haiPrefix = ((npm.cmd prefix -g) | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $haiPrefix) { throw '无法确认 npm 安装位置。' }
    npm.cmd install --global --prefix "$haiPrefix" --offline --ignore-scripts --no-audit --no-fund "$haiArchive"
    if ($LASTEXITCODE -ne 0) { throw '程序安装失败，配置未改。' }
    $haiCli = Join-Path $haiPrefix 'node_modules\hai-bridge\bin\hai-bridge.mjs'
    $haiVersion = node "$haiCli" --version
    if ($LASTEXITCODE -ne 0 -or $haiVersion -ne 'hai-bridge 0.5.1') { throw '安装版本不符，停止。' }
    node "$haiCli" use-client --client-config "$haiConfig"
    if ($LASTEXITCODE -ne 0) { throw '默认配置选择失败；原配置/密钥保留。' }
    $haiShortcut = Join-Path $haiPrefix 'haib.cmd'
    & "$haiShortcut" --help
    if ($LASTEXITCODE -ne 0) { throw '短命令入口检查失败。' }
    Write-Host "升级完成。持久短命令：$haiShortcut"
    Write-Host '以上没有发送模型请求。项目目录运行 haib.cmd 后提交任务会计费。'
}
~~~

脚本整个位于一次调用内；任何失败停止后续操作，不存在交互粘贴 throw 后下一块继续执行的问题。安装更新当前 npm prefix 内的同名程序，不修改 prefix/PATH/执行策略，旧隔离 runtime-clockfix 不动。失败后不要删除配置/密钥重配。

## 日常使用

~~~powershell
cd F:\codes\你的项目
haib.cmd
~~~

新终端不再需要临时函数。旧函数名 haib 不影响明确调用 haib.cmd。Windows 默认使用此次用户验证过的 workspace-write + MXC；更保守会话用 haib.cmd -- --sandbox read-only。

命令找不到时执行 npm.cmd prefix -g，使用打印目录下的完整 haib.cmd 路径，例如：

~~~powershell
& 'C:\你的npm目录\haib.cmd' --project 'F:\codes\你的项目'
~~~

不修改执行策略、不安装公开同名包。旧 .hai-bridge/client.json 不覆盖，use-client 新建/更新 client-default.json 指向原 .hai-bridge-v2-hai/client.json；原配置与 device 目录必须继续保留。

## 新包快速验收与回退

上面的 --help 仅检查安装入口，不启动 HAI 或证明读写权限。A 已就绪时，可在合成项目中执行 haib.cmd -- --help：仅建立连接和 GET 模型列表，不推理；正常退出后再按实际需要启动交互式会话，不重复收费修复任务。

用户此前已提供真实文件修复/4项独立测试和临时函数交互成功反馈；新包安装及短命令尚未 Windows 实测，不能补造其 PASS。原完整 acceptance FAIL 保留。[验证记录](validation.md)。

原长命令仍可显式调用旧 runtime-clockfix 和原真实 client.json，作为程序回退；不需要撤销设备或改 A。若新版安装到了原先已有全局 hai-bridge 所在 prefix，会更新那一份全局程序，重新安装旧可信 tgz 才能回退它。指针损坏时程序停止而不切旧身份；需单独处理损坏指针，不删除设备凭据。
