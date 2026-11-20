param(
    [Parameter(Mandatory = $true)][string]$EcsTarget,
    [string]$Identity = (Join-Path $env:USERPROFILE '.ssh\hai_ecs_b'),
    [string]$KnownHosts = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
    [int]$RelayPort = 18083,
    [int]$LocalPort = 18084,
    [int]$TunnelPort = 18085,
    [switch]$Infer,
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'bundle.json') -Raw | ConvertFrom-Json
if ($manifest.transport -ne 'app-tls' -or $manifest.mode -ne 'hai' -or $manifest.filename -notmatch '^hai-bridge-[0-9]+\.[0-9]+\.[0-9]+\.tgz$') { throw 'Invalid real HAI delivery manifest.' }
$archive = Join-Path $PSScriptRoot $manifest.filename
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne $manifest.sha256) { throw 'Runtime archive checksum mismatch.' }
$major = & $Node -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw 'Node.js 22+ is required.' }
Get-Command ssh -ErrorAction Stop | Out-Null
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$workspace = Join-Path $PSScriptRoot ('.local\run-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
$prefix = Join-Path $workspace 'runtime'
& $npm install --prefix $prefix --offline --ignore-scripts --no-audit --no-fund --cache (Join-Path $workspace 'npm-cache') $archive
if ($LASTEXITCODE -ne 0) { throw 'Isolated offline installation failed.' }
$cli = Join-Path $prefix 'node_modules\hai-bridge\bin\hai-bridge.mjs'
$config = Join-Path $workspace 'client.json'
$report = Join-Path $workspace 'result-hai-windows.json'
& $Node $cli init-app-client --hai --pairing-dir (Join-Path $PSScriptRoot 'client-pair') --ssh-target $EcsTarget --identity-file $Identity --known-hosts-file $KnownHosts --relay-port $RelayPort --local-port $LocalPort --tunnel-port $TunnelPort --out $config
if ($LASTEXITCODE -ne 0) { throw 'Real client initialization failed; no SSH was started.' }
$trialArgs = @($cli, 'try-hai', '--client-config', $config, '--out', $report, '--json')
if ($Infer) {
    Write-Host 'BILLABLE: exactly one short real HAI Responses request, no request retries or fault injection.'
    $trialArgs += '--infer'
} else { Write-Host 'Models only. Use -Infer explicitly for one billable streaming request.' }
& $Node @trialArgs
$code = $LASTEXITCODE
if (Test-Path -LiteralPath $report) { Write-Host ('Safe report: ' + $report) }
Write-Host ('Client config for subsequent connect-app / codex: ' + $config)
Write-Host ('Installed CLI: ' + $cli)
exit $code
