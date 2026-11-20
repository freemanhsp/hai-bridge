param(
    [Parameter(Mandatory = $true)][string]$EcsTarget,
    [string]$Identity = (Join-Path $env:USERPROFILE '.ssh\hai_ecs_b'),
    [string]$KnownHosts = (Join-Path $env:USERPROFILE '.ssh\known_hosts'),
    [string]$Pair = (Join-Path $PSScriptRoot 'client'),
    [int]$RelayPort = 18083,
    [int]$TunnelPort = 18085,
    [string]$Node = 'node',
    [string]$Report = (Join-Path $PSScriptRoot ('result-windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json'))
)
$ErrorActionPreference = 'Stop'
$runner = Join-Path $PSScriptRoot 'run.mjs'
if (-not (Test-Path -LiteralPath $runner)) {
    $runner = Join-Path $PSScriptRoot 'explore\2026-11-20-app-tls\run.mjs'
}
foreach ($file in @($runner, $Identity, $KnownHosts, (Join-Path $Pair 'pair.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'Missing runner, key, verified known_hosts or isolated client pairing.' }
}
$major = & $Node -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw 'Node.js 22+ is required.' }
& ssh -V
if ($LASTEXITCODE -ne 0) { throw 'OpenSSH Client is required.' }
Write-Host 'MOCK ONLY. A publisher must already be running. Do not run other probes during this batch.'
Write-Host 'This batch starts/stops only its own B-to-ECS SSH; no Mac Remote Login is used.'
& $Node $runner check --pair $Pair --target $EcsTarget --identity $Identity --known-hosts $KnownHosts --relay-port $RelayPort --tunnel-port $TunnelPort --out $Report
$code = $LASTEXITCODE
if (Test-Path -LiteralPath $Report -PathType Leaf) { Write-Host ('Safe report: ' + $Report) }
exit $code
