# Deploy the three desktop plugins into the app's plugin folder on THIS machine.
#
#   ...\deploy-windows.ps1 -ScriptsDir /opt/hermes/scripts   # the GATEWAY's folder
#   (or set HERMES_HOME in this shell and omit -ScriptsDir; it cannot be guessed,
#    because it belongs to the gateway, not to this machine)
#   ...\deploy-windows.ps1 -AppDir C:\tmp\plugins -Only session-usage
#
# Use this when the gateway is REMOTE from the app (e.g. the app on Windows, the
# gateway on Linux): __HERMES_SCRIPTS__ is replaced with the GATEWAY's scripts
# path, so install.sh's Windows default (%LOCALAPPDATA%\hermes\scripts) is the
# wrong path for that setup. install.sh stays the right tool for a local gateway.
[CmdletBinding()]
param(
    [string]$ScriptsDir,
    [string]$AppDir,
    [string]$Only
)

$ErrorActionPreference = 'Stop'

# The app's plugin folder. Derived rather than defaulted: with LOCALAPPDATA unset the
# old default quietly became "\hermes\desktop-plugins", i.e. a path at the root.
if (-not $AppDir) {
    if ($env:LOCALAPPDATA) {
        $AppDir = Join-Path $env:LOCALAPPDATA 'hermes\desktop-plugins'
    } else {
        Write-Host 'error: no -AppDir given, and LOCALAPPDATA is not set in this shell.'
        Write-Host '       pass the app plugin folder, e.g. -AppDir C:\Users\you\AppData\Local\hermes\desktop-plugins'
        exit 1
    }
}

# -ScriptsDir is the GATEWAY's scripts folder, so it cannot be guessed from here: a
# wrong value bakes into every plugin and only shows up much later, as a confusing
# "no working python on the gateway shell" error in a chip. Derive it from
# HERMES_HOME when that happens to be set in this shell, otherwise refuse.
if (-not $ScriptsDir) {
    if ($env:HERMES_HOME) {
        $ScriptsDir = (Join-Path $env:HERMES_HOME 'scripts').Replace('\', '/')
        Write-Host "no -ScriptsDir given; using HERMES_HOME: $ScriptsDir"
    } else {
        Write-Host 'error: no -ScriptsDir given, and HERMES_HOME is not set in this shell.'
        Write-Host '       pass the GATEWAY scripts dir, e.g. -ScriptsDir /opt/hermes/scripts'
        exit 1
    }
}

# Plugin sources are read from this script's own repo clone, never from AppDir.
$repoRoot = $PSScriptRoot

# $PSScriptRoot is populated only when the script runs from a file. Dot-sourcing or
# iex leaves it empty, and every source path below would then resolve against nothing.
if (-not $repoRoot) {
    Write-Host 'error: $PSScriptRoot is empty; run this with -File, not dot-sourced or via iex.'
    exit 1
}
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

    # A clone on Windows may check files out as CRLF (core.autocrlf=true) while the
    # committed blob is LF. The deployed file must stay byte-identical to the
    # canonical LF file, or a deployment can no longer be proved by comparing hashes
    # across machines, so normalize before comparing or writing.
    $content = $content.Replace("`r`n", "`n")

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
Write-Host "scripts path baked into the plugins: $ScriptsDir"
Write-Host "confirm <that path>/opencode_go_usage.py exists ON THE GATEWAY -- it cannot be checked from here."
Write-Host 'The app hot-reloads an edited plugin within seconds; a NEW plugin folder needs "Reload desktop plugins" from the command palette (Ctrl+K / Cmd+K).'

if ($failed) { exit 1 }
exit 0
