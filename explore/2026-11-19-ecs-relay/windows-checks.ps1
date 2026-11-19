# Public HAI Bridge mock checks. PowerShell 5.1+, Windows curl.exe.
# No real HAI calls, credentials, VPN changes or execution-policy changes.
param([string]$BaseUrl = 'http://127.0.0.1:18084', [switch]$SshRecovery)

$ErrorActionPreference = 'Stop'
$haiUri = [Uri]$BaseUrl
if ($haiUri.Scheme -ne 'http' -or $haiUri.Host -ne '127.0.0.1' -or
    $haiUri.Port -notin @(18080,18084) -or $haiUri.AbsolutePath -ne '/' -or
    $haiUri.Query -or $haiUri.Fragment -or $haiUri.UserInfo) {
    throw 'Only the loopback mock origin on port 18080/18084 is allowed.'
}
$BaseUrl = $BaseUrl.TrimEnd('/')
$haiToken = 'hai_bridge_public_mock_token_20261119'
$haiResults = [System.Collections.Generic.List[object]]::new()
$haiRunTime = [Diagnostics.Stopwatch]::StartNew()

function Assert-Hai([bool]$Condition, [string]$Reason) {
    if (-not $Condition) { throw $Reason }
}

function Invoke-HaiCurl([string]$Path, [string]$Method = 'GET',
    [AllowNull()][string]$Token = $haiToken, [int]$Seconds = 12) {
    $haiMarker = '__HAI_HTTP__'
    $haiArgs = @('--noproxy','*','-s','-N','-i','--max-time',"$Seconds",
        '-X',$Method,'--write-out',([string][char]10 + $haiMarker + '%{http_code}'))
    if ($Token) { $haiArgs += @('-H',"Authorization: Bearer $Token") }
    $haiRaw = ((& curl.exe @haiArgs "$BaseUrl$Path") -join [string][char]10).Replace([string][char]13,'')
    $haiExit = $LASTEXITCODE
    $haiPosition = $haiRaw.LastIndexOf($haiMarker)
    Assert-Hai ($haiPosition -ge 0) 'curl produced no status marker.'
    $haiStatus = [int]$haiRaw.Substring($haiPosition + $haiMarker.Length).Trim()
    $haiText = $haiRaw.Substring(0,$haiPosition)
    $haiSeparator = $haiText.IndexOf(([string][char]10 + [string][char]10))
    $haiBody = if ($haiSeparator -ge 0) { $haiText.Substring($haiSeparator + 2) } else { $haiText }
    return [pscustomobject]@{ Status = $haiStatus; Exit = $haiExit; Text = $haiText; Body = $haiBody }
}

function Get-HaiStats {
    $haiRead = Invoke-HaiCurl '/openai/v1/models'
    Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq 200) "models failed: HTTP $($haiRead.Status), curl $($haiRead.Exit)."
    $haiData = $haiRead.Body | ConvertFrom-Json
    Assert-Hai ($haiData.mock -eq $true -and $haiData.data[0].id -eq 'relay-ok') 'Not the expected MOCK fixture; abort.'
    return $haiData.stats
}

function Test-Hai([string]$Name, [scriptblock]$Action) {
    try {
        & $Action
        $haiResults.Add([pscustomobject]@{ Test = $Name; Result = 'PASS'; Detail = '' })
        Write-Host "[PASS] $Name"
    } catch {
        $haiReason = $_.Exception.Message
        $haiResults.Add([pscustomobject]@{ Test = $Name; Result = 'FAIL'; Detail = $haiReason })
        Write-Host "[FAIL] $Name -- $haiReason"
    }
}

try {
    Write-Host "MOCK ONLY | PowerShell $($PSVersionTable.PSVersion) | $BaseUrl"
    $haiInitial = Get-HaiStats
    Assert-Hai ($haiInitial.activeStreams -eq 0) 'Existing streams detected; finish those before the batch.'
    Write-Host ('BASELINE ' + ($haiInitial | ConvertTo-Json -Compress))

    Test-Hai 'health' {
        $haiRead = Invoke-HaiCurl '/healthz'
        Assert-Hai ($haiRead.Status -eq 200 -and ($haiRead.Body | ConvertFrom-Json).service -eq 'hai-bridge') 'Health check failed.'
    }

    Test-Hai 'missing/wrong token never reaches upstream' {
        $haiBefore = Get-HaiStats
        foreach ($haiCredential in @('', 'wrong_public_fixture_token')) {
            $haiRead = Invoke-HaiCurl '/openai/v1/models' 'GET' $haiCredential
            Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq 401 -and $haiRead.Body.Contains('bridge_unauthorized')) 'Expected 401 bridge_unauthorized.'
        }
        Assert-Hai ((Get-HaiStats).requests -eq $haiBefore.requests + 1) 'Rejected credentials reached upstream.'
    }

    Test-Hai 'unapproved routes/providers and methods rejected' {
        $haiBefore = Get-HaiStats
        foreach ($haiCase in @(@('/admin','GET',404), @('/anthropic/v1/messages','POST',404),
            @('/openai/v1/models','POST',405), @('/openai/v1/responses','GET',405))) {
            $haiRead = Invoke-HaiCurl $haiCase[0] $haiCase[1]
            Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq $haiCase[2]) "Wrong status for $($haiCase[0]) $($haiCase[1])."
        }
        Assert-Hai ((Get-HaiStats).requests -eq $haiBefore.requests + 1) 'Rejected routes reached upstream.'
    }

    foreach ($haiStatus in @(429,503)) {
        Test-Hai "HTTP $haiStatus status/body/retry hint; no replay" {
            $haiBefore = Get-HaiStats
            $haiRead = Invoke-HaiCurl "/openai/v1/responses?case=$haiStatus" 'POST'
            Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq $haiStatus) 'Error status was changed.'
            Assert-Hai ($haiRead.Text -match '(?im)^retry-after: *7 *$') 'Retry-After was changed.'
            Assert-Hai (($haiRead.Body | ConvertFrom-Json).error.code -eq "mock_$haiStatus") 'Error body was changed.'
            Assert-Hai ((Get-HaiStats).requests -eq $haiBefore.requests + 2) 'Unexpected request replay.'
        }
    }

    Test-Hai 'idle upstream yields 504 and later requests work' {
        $haiTimer = [Diagnostics.Stopwatch]::StartNew()
        $haiRead = Invoke-HaiCurl '/openai/v1/responses?case=stall' 'POST'
        Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq 504 -and $haiRead.Body.Contains('upstream_timeout')) "Expected 504, got $($haiRead.Status), curl $($haiRead.Exit)."
        Assert-Hai ($haiTimer.Elapsed.TotalSeconds -ge 4 -and $haiTimer.Elapsed.TotalSeconds -lt 12) 'Unexpected idle timeout duration.'
        $null = Get-HaiStats
    }

    Test-Hai 'upstream disconnect yields 502 and later requests work' {
        $haiRead = Invoke-HaiCurl '/openai/v1/responses?case=disconnect' 'POST'
        Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq 502 -and $haiRead.Body.Contains('upstream_unavailable')) "Expected 502, got $($haiRead.Status), curl $($haiRead.Exit)."
        $null = Get-HaiStats
    }

    Test-Hai 'four concurrent SSE streams complete and clean up' {
        $haiBefore = Get-HaiStats
        $haiJobs = @()
        try {
            for ($haiIndex = 0; $haiIndex -lt 4; $haiIndex++) {
                $haiJobs += Start-Job -ArgumentList "$BaseUrl/openai/v1/responses?case=stream",$haiToken -ScriptBlock {
                    param($haiUrl,$haiCredential)
                    $haiText = (& curl.exe --noproxy '*' -s -N --max-time 12 -X POST -H "Authorization: Bearer $haiCredential" $haiUrl) -join [string][char]10
                    [pscustomobject]@{ Exit = $LASTEXITCODE; Text = $haiText }
                }
            }
            $haiPeak = 0
            $haiWait = [Diagnostics.Stopwatch]::StartNew()
            do {
                Assert-Hai ($haiWait.Elapsed.TotalSeconds -lt 30) 'Concurrent jobs did not finish in time.'
                $haiPeak = [Math]::Max($haiPeak,(Get-HaiStats).activeStreams)
                Start-Sleep -Milliseconds 200
            } while (@($haiJobs | Where-Object { $_.State -notin @('Completed','Failed','Stopped') }).Count -gt 0)
            foreach ($haiJob in $haiJobs) {
                $haiResult = Receive-Job -Job $haiJob -ErrorAction Stop
                Assert-Hai ($haiResult.Exit -eq 0 -and $haiResult.Text.Contains('response.completed')) 'Concurrent SSE was incomplete.'
                Assert-Hai (([regex]::Matches($haiResult.Text,'response.output_text.delta')).Count -eq 3) 'Concurrent SSE delta count changed.'
            }
            $haiAfter = Get-HaiStats
            Assert-Hai ($haiPeak -ge 2) 'No overlapping upstream streams were observed.'
            Assert-Hai ($haiAfter.completedStreams -eq $haiBefore.completedStreams + 4 -and $haiAfter.activeStreams -eq 0) 'Concurrent streams did not clean up.'
        } finally {
            foreach ($haiJob in $haiJobs) {
                if ($haiJob.State -notin @('Completed','Failed','Stopped')) { Stop-Job -Job $haiJob }
                Remove-Job -Job $haiJob -Force
            }
        }
    }

    Test-Hai '20-second live SSE survives idle setting; cancellation cleans up' {
        $haiBefore = Get-HaiStats
        $haiTimer = [Diagnostics.Stopwatch]::StartNew()
        $haiRead = Invoke-HaiCurl '/openai/v1/responses?case=cancel' 'POST' $haiToken 20
        Assert-Hai ($haiRead.Exit -eq 28 -and $haiRead.Status -eq 200 -and $haiTimer.Elapsed.TotalSeconds -ge 18) 'Long stream ended before client cancellation.'
        Assert-Hai (([regex]::Matches($haiRead.Body,'mock-tick-')).Count -ge 10) 'Long stream did not remain active.'
        Assert-Hai (-not $haiRead.Body.Contains('response.completed')) 'Cancelled stream incorrectly completed.'
        $haiPolls = 0
        do {
            $haiAfter = Get-HaiStats
            $haiPolls++
            if ($haiAfter.activeStreams -eq 0 -and $haiAfter.cancelledStreams -eq $haiBefore.cancelledStreams + 1) { break }
            Start-Sleep -Milliseconds 200
        } while ($haiPolls -lt 20)
        Assert-Hai ($haiAfter.activeStreams -eq 0 -and $haiAfter.cancelledStreams -eq $haiBefore.cancelledStreams + 1) 'Cancellation left an upstream stream.'
        Assert-Hai ($haiAfter.completedStreams -eq $haiBefore.completedStreams) 'Cancelled request completed upstream.'
        Assert-Hai ($haiAfter.requests -eq $haiBefore.requests + 1 + $haiPolls) 'Cancelled request was replayed.'
    }

    Test-Hai 'final health, no credential rejects or active streams' {
        $haiFinal = Get-HaiStats
        Assert-Hai ($haiFinal.activeStreams -eq 0 -and $haiFinal.rejectedAuth -eq 0) 'Streams or credential rejects remain.'
        Write-Host ('FINAL ' + ($haiFinal | ConvertTo-Json -Compress))
    }

    if ($SshRecovery) {
        Test-Hai 'SSH in-flight interruption, manual recovery and no old-request replay' {
            $haiBefore = Get-HaiStats
            Assert-Hai ($haiBefore.activeStreams -eq 0) 'Cannot interrupt while other streams are active.'
            $haiJob = Start-Job -ArgumentList "$BaseUrl/openai/v1/responses?case=cancel",$haiToken -ScriptBlock {
                param($haiUrl,$haiCredential)
                $haiText = (& curl.exe --noproxy '*' -s -N --max-time 55 -X POST -H "Authorization: Bearer $haiCredential" $haiUrl) -join [string][char]10
                [pscustomobject]@{ Exit = $LASTEXITCODE; Text = $haiText }
            }
            try {
                $haiBeforePolls = 0
                do {
                    $haiActive = Get-HaiStats
                    $haiBeforePolls++
                    if ($haiActive.activeStreams -eq 1) { break }
                    Start-Sleep -Milliseconds 200
                } while ($haiBeforePolls -lt 20)
                Assert-Hai ($haiActive.activeStreams -eq 1) 'Interruption probe did not start.'
                Write-Host 'Within 30 seconds: switch to the TEST SSH window and press Ctrl-C there only. Keep VPN and Mac services running.'
                $null = Read-Host 'After SSH stops, return HERE and press Enter'
                try {
                $haiRead = Invoke-HaiCurl '/openai/v1/models' 'GET' $haiToken 3
                Assert-Hai ($haiRead.Exit -ne 0 -and $haiRead.Status -eq 0) 'HTTP remained reachable: the intended tunnel may not have stopped.'
                $null = Wait-Job -Job $haiJob -Timeout 5
                Assert-Hai ($haiJob.State -eq 'Completed') 'In-flight curl did not terminate when SSH stopped.'
                $haiInterrupted = Receive-Job -Job $haiJob -ErrorAction Stop
                Assert-Hai ($haiInterrupted.Exit -ne 0 -and $haiInterrupted.Exit -ne 28 -and
                    $haiInterrupted.Text.Contains('mock-tick-') -and -not $haiInterrupted.Text.Contains('response.completed')) 'In-flight stream was not interrupted by SSH; do the stop sooner.'
                } finally {
                Write-Host 'Now restart in the ORIGINAL SSH window using the command below:'
                Write-Host 'ssh @haiMacArgs -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 -N -L 127.0.0.1:18084:127.0.0.1:18080 I605103@127.0.0.1'
                $null = Read-Host 'When that window stays running, return HERE and press Enter'
                }
                $haiAfter = Get-HaiStats
                Assert-Hai ($haiAfter.activeStreams -eq 0 -and $haiAfter.cancelledStreams -eq $haiBefore.cancelledStreams + 1) 'Interrupted stream left upstream work running.'
                Assert-Hai ($haiAfter.requests -eq $haiBefore.requests + $haiBeforePolls + 2) 'Old request was replayed or fixture changed.'
                $haiRead = Invoke-HaiCurl '/openai/v1/responses?case=stream' 'POST'
                Assert-Hai ($haiRead.Exit -eq 0 -and $haiRead.Status -eq 200 -and $haiRead.Body.Contains('response.completed')) 'New SSE did not work after manual recovery.'
            } finally {
                if ($haiJob.State -notin @('Completed','Failed','Stopped')) { Stop-Job -Job $haiJob }
                Remove-Job -Job $haiJob -Force
            }
        }
    }
} catch {
    $haiResults.Add([pscustomobject]@{ Test = 'preflight/batch'; Result = 'FAIL'; Detail = $_.Exception.Message })
    Write-Host "[FAIL] preflight/batch -- $($_.Exception.Message)"
}

$haiFailed = @($haiResults | Where-Object { $_.Result -eq 'FAIL' }).Count
Write-Host "SUMMARY: $($haiResults.Count - $haiFailed) PASS / $haiFailed FAIL | $([Math]::Round($haiRunTime.Elapsed.TotalSeconds,1)) seconds"
if ($haiFailed -gt 0) { $haiResults | Where-Object { $_.Result -eq 'FAIL' } | Format-Table -AutoSize -Wrap }
Write-Host 'WSL, real HAI, automatic SSH reconnect, sleep and account hardening are NOT covered.'
