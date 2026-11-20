param(
    [Parameter(Mandatory = $true)][string]$RuntimeArchive,
    [Parameter(Mandatory = $true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [string]$ExistingClientConfig,
    [string]$ProfileDirectory = (Join-Path $env:USERPROFILE '.hai-bridge'),
    [string]$ProjectDirectory = (Get-Location).Path,
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
# Only model-list GETs and Codex --help. No inference, fault injection, process-name kill or trust changes.
$archive = (Resolve-Path -LiteralPath $RuntimeArchive).Path
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $ExpectedSha256) { throw 'Archive checksum mismatch. Nothing installed.' }
$major = & $Node -p 'parseInt(process.versions.node)'
if ($LASTEXITCODE -ne 0 -or [int]$major -lt 22) { throw 'Node.js 22+ is required.' }
Get-Command ssh -ErrorAction Stop | Out-Null
$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
& $npm install --global --offline --ignore-scripts --no-audit --no-fund $archive
if ($LASTEXITCODE -ne 0) { throw 'Offline runtime installation failed.' }
$prefix = & $npm prefix --global
if ($LASTEXITCODE -ne 0) { throw 'Cannot locate installed npm prefix.' }
$cli = Join-Path $prefix.Trim() 'node_modules\hai-bridge\bin\hai-bridge.mjs'
$version = & $Node $cli --version
if ($LASTEXITCODE -ne 0 -or $version -ne 'hai-bridge 0.5.0') { throw 'Expected hai-bridge 0.5.0.' }
$config = Join-Path $ProfileDirectory 'client.json'
if (-not (Test-Path -LiteralPath $config)) {
    if (-not $ExistingClientConfig) { throw 'First use needs -ExistingClientConfig pointing to the successful real trial client.json.' }
    & $Node $cli setup-client --client-config $ExistingClientConfig --profile-dir $ProfileDirectory
    if ($LASTEXITCODE -ne 0) { throw 'Private profile setup failed; existing files were not replaced.' }
} elseif ($ExistingClientConfig) { Write-Host 'Reusing existing private daily profile; no overwrite or renewal.' }
$raw = Get-Content -LiteralPath $config -Raw | ConvertFrom-Json
if ($raw.transport -ne 'app-tls' -or $raw.mode -ne 'hai' -or $raw.role -ne 'client') { throw 'A real app-tls client is required.' }
$project = (Resolve-Path -LiteralPath $ProjectDirectory).Path
function Assert-FreePort([int]$Port) {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    try { $listener.Start() } catch { throw 'B port is occupied. Stop your own old connect-app/session; no process was stopped by this script.' }
    finally { $listener.Stop() }
}
Assert-FreePort ([int]$raw.local_port)
Assert-FreePort ([int]$raw.tunnel_port)
$checks = @()
$passed = $true
Write-Host 'Mac HAI/publish-app must already be running. This checks two start/normal-exit cycles with Codex --help, not a model task.'
for ($cycle = 1; $cycle -le 2; $cycle++) {
    & $Node $cli start --profile-dir $ProfileDirectory --project $project -- --help
    $code = $LASTEXITCODE
    try {
        Assert-FreePort ([int]$raw.local_port)
        Assert-FreePort ([int]$raw.tunnel_port)
        $free = $true
    } catch { $free = $false }
    $ok = ($code -eq 0 -and $free)
    $checks += [ordered]@{ check = ('start-help-normal-cleanup-cycle-' + $cycle); status = $(if ($ok) { 'pass' } else { 'fail' }) }
    if (-not $ok) { $passed = $false; break }
}
$report = [ordered]@{
    version = '0.5.0'; runtime_sha256 = $ExpectedSha256.ToLower(); platform = 'win32'; transport = 'app-tls'
    evidence = 'Windows-session-help-B-ECS-A'; inference = 'not_requested'; status = $(if ($passed) { 'pass' } else { 'fail' })
    checks = $checks
    not_checked = @('Ctrl_C_process_tree_cleanup', 'WSL', 'real_AI_tool_task', 'A_outer_link_recovery', 'VPN_sleep_resume', 'long_term_stability')
}
$reportDirectory = Join-Path $project '.local'
[System.IO.Directory]::CreateDirectory($reportDirectory) | Out-Null
$reportFile = Join-Path $reportDirectory ('start-check-windows-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.json')
$stream = [System.IO.File]::Open($reportFile, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write)
$writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
try { $writer.Write(($report | ConvertTo-Json -Depth 5)) } finally { $writer.Dispose() }
Write-Host ('Safe report: ' + $reportFile)
if (-not $passed) { throw 'Session check failed; see safe report. No unrelated process was stopped.' }
Write-Host 'PASS. Daily use from a nonsensitive project: hai-bridge.cmd start'
Write-Host 'A real Codex task is billable. Ctrl-C cleanup on Windows still needs a separate observation.'
