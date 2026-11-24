param(
    [Parameter(Mandatory = $true)][string]$ClientConfig,
    [Parameter(Mandatory = $true)][string]$Out,
    [string]$Node = 'node'
)
$ErrorActionPreference = 'Stop'
$cli = Join-Path $PSScriptRoot '..\bin\hai-bridge.mjs'
Write-Host 'V2 MOCK ONLY: A must be running and this B fingerprint approved. Stop old B connect-app first.'
Write-Host 'This batch owns only its B listener/SSH; it does not revoke devices, modify A, or call real HAI.'
& $Node $cli check-device --client-config $ClientConfig --out $Out --json
exit $LASTEXITCODE
