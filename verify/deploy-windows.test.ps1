$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$deploy = Join-Path $repoRoot 'deploy-windows.ps1'
$engine = (Get-Process -Id $PID).Path
$root = Join-Path ([IO.Path]::GetTempPath()) ('hermes-deploy-test-' + [guid]::NewGuid())
$savedHome = $env:HERMES_HOME
$ids = @('deepseek-rate', 'opencode-usage', 'session-usage')

function Assert($Condition, [string]$Message) {
    if (-not $Condition) { throw $Message }
}

function Deploy([string[]]$DeployArgs, [int]$ExpectedExit = 0) {
    $output = & $engine -NoProfile -File $deploy @DeployArgs 2>&1
    Assert ($LASTEXITCODE -eq $ExpectedExit) "Expected exit $ExpectedExit, got ${LASTEXITCODE}: $output"
    return ($output -join "`n")
}

function Check-Files([string]$AppDir, [string[]]$PluginIds, [string]$Literal) {
    $files = @(Get-ChildItem -LiteralPath $AppDir -Recurse -File)
    Assert ($files.Count -eq $PluginIds.Count) 'Unexpected deployed file count'
    foreach ($id in $PluginIds) {
        $path = Join-Path (Join-Path $AppDir $id) 'plugin.js'
        $bytes = [IO.File]::ReadAllBytes($path)
        Assert (-not ($bytes.Length -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191)) "$id has a UTF-8 BOM"
        $utf8 = New-Object System.Text.UTF8Encoding($false, $true)
        $content = $utf8.GetString($bytes)
        Assert (-not $content.Contains("`r")) "$id is not LF-only"
        Assert (-not $content.Contains('__HERMES_SCRIPTS__')) "$id retains the scripts token"
        $src = Join-Path (Join-Path (Join-Path $repoRoot 'desktop-plugins') $id) 'plugin.js'
        $expected = [IO.File]::ReadAllText($src).Replace('__HERMES_SCRIPTS__', $Literal).Replace("`r`n", "`n")
        Assert ($content -ceq $expected) "$id differs from the expected JS literal substitution"
    }
}

try {
    $env:HERMES_HOME = $null
    $app = Join-Path $root 'full'
    # install.sh escapes backslashes first, then single quotes for the JS literal.
    $scripts = "C:\gateway's\scripts"
    $literal = 'C:\\gateway\''s\\scripts'
    $null = Deploy @('-AppDir', $app, '-ScriptsDir', $scripts)
    Check-Files $app $ids $literal
    Write-Host 'PASS: full deploy; JS escaping, no tokens, UTF-8 without BOM, LF only (3 plugins)'

    $output = Deploy @('-AppDir', $app, '-ScriptsDir', $scripts)
    $unchanged = @($output -split "`n" | Where-Object { $_ -like 'unchanged *' })
    Assert ($unchanged.Count -eq 3 -and $output -notmatch '(?m)^wrote ') 'Second deploy did not report all plugins unchanged'
    Write-Host 'PASS: second deploy reports unchanged (3 plugins)'

    $bracketApp = Join-Path $root 'plugins[42]'
    $output = Deploy @('-AppDir', $bracketApp, '-ScriptsDir', $scripts)
    Check-Files $bracketApp $ids $literal
    $hashes = [regex]::Matches($output, '(?m)^  sha256 ([0-9A-Fa-f]{64})\r?$')
    Assert ($hashes.Count -eq $ids.Count) 'Bracket AppDir did not print three 64-hex SHA256 hashes'
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        for ($i = 0; $i -lt $ids.Count; $i++) {
            $path = Join-Path (Join-Path $bracketApp $ids[$i]) 'plugin.js'
            $expectedHash = [BitConverter]::ToString($sha.ComputeHash([IO.File]::ReadAllBytes($path))).Replace('-', '')
            Assert ($hashes[$i].Groups[1].Value -eq $expectedHash) "Wrong SHA256 for $($ids[$i]) in bracket AppDir"
        }
    } finally {
        $sha.Dispose()
    }
    Write-Host "PASS: bracket AppDir prints three matching literal-file SHA256 hashes (PowerShell $($PSVersionTable.PSVersion))"

    $only = Join-Path $root 'only'
    $null = Deploy @('-AppDir', $only, '-ScriptsDir', $scripts, '-Only', 'session-usage')
    Check-Files $only @('session-usage') $literal
    Write-Host 'PASS: -Only session-usage deploys only that plugin'

    $invalid = Join-Path $root 'invalid'
    $null = Deploy @('-AppDir', $invalid, '-ScriptsDir', $scripts, '-Only', 'unknown-plugin') 1
    Assert (-not (Test-Path -LiteralPath $invalid)) 'Unknown -Only wrote files'
    Write-Host 'PASS: unknown -Only exits 1'

    $missing = Join-Path $root 'missing'
    $null = Deploy @('-AppDir', $missing) 1
    Assert (-not (Test-Path -LiteralPath $missing)) 'Missing scripts path wrote files'
    Write-Host 'PASS: missing -ScriptsDir with HERMES_HOME unset exits 1'

    $relative = Join-Path $root 'relative'
    $output = Deploy @('-AppDir', $relative, '-ScriptsDir', 'scripts') 1
    Assert ($output -match 'must be absolute on the gateway') 'Relative -ScriptsDir did not name the absolute-path requirement'
    Assert (-not (Test-Path -LiteralPath $relative)) 'Relative -ScriptsDir wrote files'
    Write-Host 'PASS: relative -ScriptsDir exits 1 before writing'

    $env:HERMES_HOME = 'relative-gateway-home'
    $derivedRelative = Join-Path $root 'derived-relative'
    $null = Deploy @('-AppDir', $derivedRelative) 1
    Assert (-not (Test-Path -LiteralPath $derivedRelative)) 'Relative HERMES_HOME wrote files'
    $env:HERMES_HOME = $null
    Write-Host 'PASS: relative HERMES_HOME fallback exits 1 before writing'

    $uncApp = Join-Path $root 'unc'
    $uncScripts = '\\server\share\scripts'
    $uncLiteral = '\\\\server\\share\\scripts'
    $null = Deploy @('-AppDir', $uncApp, '-ScriptsDir', $uncScripts)
    Check-Files $uncApp $ids $uncLiteral
    Write-Host 'PASS: backslash UNC ScriptsDir stays accepted and escaped'

    $env:HERMES_HOME = Join-Path $root 'gateway'
    $fallback = Join-Path $root 'fallback'
    $null = Deploy @('-AppDir', $fallback)
    $homeScripts = $env:HERMES_HOME.Replace('\', '/') + '/scripts'
    Check-Files $fallback $ids $homeScripts
    Write-Host 'PASS: HERMES_HOME fallback uses <HERMES_HOME>/scripts'

    $driveNames = @(Get-PSDrive | ForEach-Object { $_.Name })
    $unusedDrive = 90..65 | ForEach-Object { [string][char]$_ } | Where-Object { $driveNames -notcontains $_ } | Select-Object -First 1
    Assert ($null -ne $unusedDrive) 'No unused drive letter available for remote gateway test'
    $remoteScripts = $unusedDrive + ':/remote-hermes/scripts'
    $case = 0
    foreach ($ending in @('', '\', '/')) {
        $env:HERMES_HOME = $unusedDrive + ':\remote-hermes' + $ending
        $remote = Join-Path $root ('remote-' + $case++)
        $null = Deploy @('-AppDir', $remote)
        Check-Files $remote $ids $remoteScripts
    }
    Write-Host 'PASS: remote-only drive fallback; exact path with or without trailing separator'
    Write-Host "PASS: deployment checks complete (PowerShell $($PSVersionTable.PSVersion))"
} finally {
    $env:HERMES_HOME = $savedHome
    if (Test-Path -LiteralPath $root) { Remove-Item -LiteralPath $root -Recurse -Force }
}
