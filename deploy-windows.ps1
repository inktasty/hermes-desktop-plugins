# Deploy the three desktop plugins into the app's plugin folder on THIS machine.
#
#   powershell -ExecutionPolicy Bypass -File .\deploy-windows.ps1
#   ...\deploy-windows.ps1 -ScriptsDir /opt/hermes/scripts
#   ...\deploy-windows.ps1 -AppDir C:\tmp\plugins -Only session-usage
#
# Use this when the gateway is REMOTE from the app (e.g. the app on Windows, the
# gateway on Linux): __HERMES_SCRIPTS__ is replaced with the GATEWAY's scripts
# path, so install.sh's Windows default (%LOCALAPPDATA%\hermes\scripts) is the
# wrong path for that setup. install.sh stays the right tool for a local gateway.
[CmdletBinding()]
param(
    [string]$ScriptsDir = '/home/ubuntu/.hermes/scripts',
    [string]$AppDir = "$env:LOCALAPPDATA\hermes\desktop-plugins",
    [string]$Only
)

$ErrorActionPreference = 'Stop'

# Plugin sources are read from this script's own repo clone, never from AppDir.
$repoRoot = $PSScriptRoot
$pluginIds = @('deepseek-rate', 'opencode-usage', 'session-usage')

# The shipped placeholder; every occurrence is replaced with the scripts path.
$scriptsToken = '__HERMES_SCRIPTS__'

if ($Only) {
    if ($pluginIds -notcontains $Only) {
        Write-Host "unknown plugin id '$Only'; expected one of: $($pluginIds -join ', ')"
        exit 1
    }
    $pluginIds = @($Only)
}

# UTF-8 without a BOM: the app reads the file as plain JS.
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$failed = $false

foreach ($id in $pluginIds) {
    $src = Join-Path $repoRoot "desktop-plugins\$id\plugin.js"
    $dest = Join-Path (Join-Path $AppDir $id) 'plugin.js'

    if (-not [System.IO.File]::Exists($src)) {
        Write-Host "missing source $src"
        $failed = $true
        continue
    }

    # Point the plugin at the gateway's scripts. Nothing else in the file changes.
    $content = ([System.IO.File]::ReadAllText($src)).Replace($scriptsToken, $ScriptsDir)

    $destDir = Split-Path -Parent $dest
    if (-not [System.IO.Directory]::Exists($destDir)) {
        [System.IO.Directory]::CreateDirectory($destDir) | Out-Null
    }

    # Skip the write when the app copy already holds this exact content.
    $existing = $null
    if ([System.IO.File]::Exists($dest)) { $existing = [System.IO.File]::ReadAllText($dest) }

    if ($existing -ceq $content) {
        Write-Host "unchanged $dest"
    } else {
        [System.IO.File]::WriteAllText($dest, $content, $utf8NoBom)
        $hash = (Get-FileHash -Algorithm SHA256 -Path $dest).Hash
        Write-Host "wrote $dest"
        Write-Host "  sha256 $hash"
    }

    # The one bug this must never have: the placeholder surviving from repo to app.
    if ([System.IO.File]::ReadAllText($dest).Contains($scriptsToken)) {
        Write-Host "FAIL: $dest still contains $scriptsToken"
        $failed = $true
    }
}

Write-Host ''
Write-Host "plugins deployed to $AppDir"
Write-Host 'The app hot-reloads an edited plugin within seconds; a NEW plugin folder needs "Reload desktop plugins" from the command palette (Ctrl+K / Cmd+K).'

if ($failed) { exit 1 }
exit 0
