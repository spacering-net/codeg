#
# Codeg Server installer for Windows
# Usage:
#   irm https://raw.githubusercontent.com/spacering-net/codeg/main/install.ps1 | iex
#   .\install.ps1 -Version v0.5.0
#

param(
    [string]$Version = "",
    [string]$InstallDir = "",
    [switch]$NoCleanup
)

$ErrorActionPreference = "Stop"
$Repo = "spacering-net/codeg"
$Artifact = "codeg-server-windows-x64"

# Where the server goes when no -InstallDir is given. Not
# $env:LOCALAPPDATA\codeg: the codeg desktop app installs itself there for
# one user, and it ships codeg-mcp.exe, codeg-computer-helper.exe and web\
# of its own, which each installer would replace with its own. Earlier
# versions of this script installed the server there all the same. A server
# they left there stays — unless the desktop app is there too: then it moves
# here (see "Move out of the desktop app's folder" below).
$DefaultDir = Join-Path $env:LOCALAPPDATA "codeg-server"
$LegacyDir = Join-Path $env:LOCALAPPDATA "codeg"
$MoveFrom = ""
if (-not $InstallDir) {
    $InstallDir = $DefaultDir
    if (Test-Path -LiteralPath (Join-Path $LegacyDir "codeg-server.exe") -PathType Leaf) {
        if (Test-Path -LiteralPath (Join-Path $LegacyDir "codeg.exe") -PathType Leaf) {
            $MoveFrom = $LegacyDir
        } else {
            $InstallDir = $LegacyDir
        }
    }
}
# Absolute, from where PowerShell is — as its own file commands read a
# relative path — not from the process's directory, which .NET's path
# functions use and which PowerShell does not move.
$InstallDir = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($InstallDir)
if (Test-Path -LiteralPath (Join-Path $InstallDir "codeg.exe") -PathType Leaf) {
    Write-Error "$InstallDir holds the codeg desktop app, whose codeg-mcp.exe, codeg-computer-helper.exe and web\ the server's would replace. Install codeg-server in a folder of its own (by default $DefaultDir)."
    exit 1
}

# Names of binaries this installer manages. codeg-server is the user-facing
# entry point; codeg-mcp is the stdio MCP companion that the server's ACP
# layer spawns per session for delegation. Both must live in the same
# directory — `locate_codeg_mcp_binary()` in src-tauri/src/acp/connection.rs
# resolves the companion as a sibling of the running server executable.
$ManagedBins = @("codeg-server", "codeg-mcp")

# Stale codeg-server / codeg-mcp binaries elsewhere in PATH are removed by
# default so the user's `codeg-server` command always runs the freshly
# installed binary AND the runtime locates the matching companion via the
# exe-sibling lookup. Pass -NoCleanup (or set CODEG_NO_CLEANUP=1) to disable.
$Cleanup = -not $NoCleanup
if ($env:CODEG_NO_CLEANUP -eq "1") {
    $Cleanup = $false
}

function Get-CanonicalPath([string]$Path) {
    if (-not $Path) { return "" }
    try {
        return (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
    } catch {
        return $Path
    }
}

# Whether two PATH entries name the same folder: compared expanded, without a
# trailing backslash, ignoring case — not as substrings, since
# ...\Local\codeg is a prefix of ...\Local\codeg-server.
function Test-SameDir([string]$A, [string]$B) {
    $a = [Environment]::ExpandEnvironmentVariables($A).TrimEnd('\')
    $b = [Environment]::ExpandEnvironmentVariables($B).TrimEnd('\')
    return $a -eq $b
}

function Test-PathHasDir([string]$PathValue, [string]$Dir) {
    if (-not $PathValue) { return $false }
    foreach ($entry in $PathValue.Split(';')) {
        if ($entry -and (Test-SameDir $entry $Dir)) { return $true }
    }
    return $false
}

function Read-BinVersion([string]$BinPath) {
    if (-not (Test-Path -LiteralPath $BinPath)) { return "" }
    $stdout = Join-Path $env:TEMP ("codeg-ver-" + [Guid]::NewGuid().ToString() + ".txt")
    $stderr = Join-Path $env:TEMP ("codeg-vererr-" + [Guid]::NewGuid().ToString() + ".txt")
    try {
        $proc = Start-Process -FilePath $BinPath -ArgumentList "--version" `
            -NoNewWindow -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        $exited = $proc.WaitForExit(3000)
        if (-not $exited) { try { $proc.Kill() } catch {} }
        if (Test-Path $stdout) {
            $line = (Get-Content $stdout -ErrorAction SilentlyContinue | Select-Object -First 1)
            if ($line) { return $line.Trim() }
        }
        return ""
    } catch {
        return ""
    } finally {
        Remove-Item $stdout -Force -ErrorAction SilentlyContinue
        Remove-Item $stderr -Force -ErrorAction SilentlyContinue
    }
}

# ── Resolve version ──

if (-not $Version) {
    Write-Host "Fetching latest release..."
    $release = Invoke-RestMethod "https://api.github.com/repos/$Repo/releases/latest"
    $Version = $release.tag_name
    if (-not $Version) {
        Write-Error "Could not determine latest version"
        exit 1
    }
}

$TargetVer = $Version -replace '^v', ''

# ── Scan PATH for codeg-server binaries that shadow the target install ──
#
# A binary "shadows" the install if it appears in PATH BEFORE the destination
# directory: that's the binary `Get-Command codeg-server` returns after install.
# Unlike install.sh (which doesn't modify PATH), this script appends
# `$InstallDir` to user PATH below when it's missing, so any pre-existing
# codeg-server in PATH ends up before the destination after install and must be
# cleaned. We therefore collect conflicts even when the destination isn't on
# PATH yet: stop the walk at the destination if present, otherwise scan to the
# end (post-install, the destination will be at the tail).

$DestBin = Join-Path $InstallDir "codeg-server.exe"
$DestBinReal = Get-CanonicalPath $DestBin
$InstallDirReal = Get-CanonicalPath $InstallDir

$PathConflicts = @()
$seenReal = @{}
$pathDirs = @()
if ($env:Path) { $pathDirs = $env:Path.Split(';') }
# Scan PATH for both managed binaries — a stale `codeg-mcp.exe` in an earlier
# PATH entry would be picked by the runtime's `which` fallback once
# `codeg-server.exe` was upgraded out from under it, breaking delegation in
# subtle ways. Track conflicts uniformly for cleanup.
foreach ($dir in $pathDirs) {
    if (-not $dir) { continue }
    # Match by canonical path string so the destination is recognized even when
    # the directory doesn't exist yet (e.g. first install into a fresh prefix).
    $dirReal = Get-CanonicalPath $dir
    if ($dirReal -eq $InstallDirReal) {
        break
    }
    # In the desktop app's folder only a codeg-server.exe is a server's
    # leftover: the codeg-mcp.exe there is the desktop app's own.
    $desktopDir = Test-Path -LiteralPath (Join-Path $dir "codeg.exe") -PathType Leaf
    foreach ($name in $ManagedBins) {
        if ($desktopDir -and $name -ne "codeg-server") { continue }
        foreach ($leaf in @("$name.exe", $name)) {
            $bin = Join-Path $dir $leaf
            if (Test-Path -LiteralPath $bin -PathType Leaf) {
                $real = Get-CanonicalPath $bin
                if ($seenReal.ContainsKey($real)) { continue }
                $seenReal[$real] = $true
                $PathConflicts += $bin
            }
        }
    }
}

# What does `codeg-server` actually resolve to in the current PATH?
$ActiveBin = ""
$resolved = Get-Command codeg-server -ErrorAction SilentlyContinue
if ($resolved) { $ActiveBin = $resolved.Source }

# ── Version detection — prefer the binary the user actually invokes ──

$VersionCheckBin = ""
if ($ActiveBin -and (Test-Path -LiteralPath $ActiveBin)) {
    $VersionCheckBin = $ActiveBin
} elseif (Test-Path -LiteralPath $DestBin) {
    $VersionCheckBin = $DestBin
}

$CurrentVersion = ""
$WasRunning = $false
if ($VersionCheckBin) {
    $CurrentVersion = Read-BinVersion $VersionCheckBin
}

# Only short-circuit when the active binary is up to date AND the destination
# itself has it AND no other PATH entries shadow it.
if ($CurrentVersion -and ($CurrentVersion -eq $TargetVer) `
        -and ($PathConflicts.Count -eq 0) `
        -and (Test-Path -LiteralPath $DestBin)) {
    Write-Host "codeg-server is already at version $TargetVer, nothing to do."
    exit 0
}

if ($CurrentVersion) {
    Write-Host "Upgrading codeg-server: $CurrentVersion -> $TargetVer..."
} else {
    Write-Host "Installing codeg-server $Version (windows/x64)..."
}

# ── Warn about codeg-server binaries shadowing the target install ──

if ($PathConflicts.Count -gt 0) {
    Write-Host ""
    Write-Host "Found other codeg-server binaries in PATH that may shadow ${DestBin}:"
    foreach ($c in $PathConflicts) {
        $cv = Read-BinVersion $c
        if ($cv) {
            Write-Host "  - $c  (version $cv)"
        } else {
            Write-Host "  - $c"
        }
    }
    if ($Cleanup) {
        Write-Host "These will be removed after installation. Pass -NoCleanup to keep them."
    } else {
        Write-Host "Keeping them (-NoCleanup). You may need to remove them manually so that"
        Write-Host "typing 'codeg-server' runs the new install at $DestBin."
    }
    Write-Host ""
}

# ── Stop running service before upgrade ──
#
# codeg-mcp.exe is the stdio MCP companion spawned per ACP session.
# On Windows, Copy-Item -Force fails with a sharing violation if the
# target .exe is currently running (the OS holds an exclusive write
# lock on executable images), and Remove-Item fails the same way. Stop
# what runs from the files this script replaces or removes — and only
# that: the desktop app runs a codeg-mcp.exe and a codeg-computer-helper.exe
# of its own, from its own folder. A process whose path cannot be read
# (another user's, an elevated one) is left alone; Stop-Process could not
# stop it either.

$Changing = @(
    (Join-Path $InstallDir "codeg-server.exe"),
    (Join-Path $InstallDir "codeg-mcp.exe"),
    (Join-Path $InstallDir "codeg-computer-helper.exe")
)
if ($Cleanup) {
    $Changing += $PathConflicts
    if ($MoveFrom) { $Changing += (Join-Path $MoveFrom "codeg-server.exe") }
}
$Changing = @($Changing | ForEach-Object {
    [System.IO.Path]::GetFullPath($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($_))
})

# The processes named $Name that run one of the files in $Changing. Their
# paths come from CIM, which reads every process's, whatever this
# PowerShell's bitness: a 32-bit one cannot read a 64-bit process's own
# `Path`. Where CIM cannot be had, Get-Process reads what it can.
function Get-RunningFrom([string]$Name) {
    try {
        $running = @(Get-CimInstance Win32_Process -Filter "Name = '$Name.exe'" -ErrorAction Stop |
            Where-Object {
                $_.ExecutablePath -and ($Changing -contains [System.IO.Path]::GetFullPath($_.ExecutablePath))
            })
        return @($running | ForEach-Object { Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue })
    } catch {
        return @(Get-Process -Name $Name -ErrorAction SilentlyContinue | Where-Object {
            $path = $null
            try { $path = $_.Path } catch {}
            $path -and ($Changing -contains [System.IO.Path]::GetFullPath($path))
        })
    }
}

$ServerProcesses = Get-RunningFrom "codeg-server"
if ($ServerProcesses) {
    Write-Host "Stopping running codeg-server process(es)..."
    $WasRunning = $true
    $ServerProcesses | Stop-Process -Force
    Start-Sleep -Seconds 2
    # Verify stopped
    $StillRunning = Get-RunningFrom "codeg-server"
    if ($StillRunning) {
        $StillRunning | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
    Write-Host "codeg-server stopped."
}

# codeg-computer-helper.exe exits with the codeg-server that started it, but
# not necessarily before the copy below; it holds its file the same way.
# Stopped with the cua-driver it runs (`taskkill /T`).
$HelperProcesses = Get-RunningFrom "codeg-computer-helper"
if ($HelperProcesses) {
    Write-Host "Stopping running codeg-computer-helper process(es)..."
    foreach ($p in $HelperProcesses) {
        try { & taskkill.exe /F /T /PID $p.Id 2>$null | Out-Null } catch {}
    }
    Start-Sleep -Seconds 1
}

$McpProcesses = Get-RunningFrom "codeg-mcp"
if ($McpProcesses) {
    Write-Host "Stopping running codeg-mcp companion process(es)..."
    $McpProcesses | Stop-Process -Force
    Start-Sleep -Seconds 1
    $StillRunning = Get-RunningFrom "codeg-mcp"
    if ($StillRunning) {
        $StillRunning | Stop-Process -Force
        Start-Sleep -Seconds 1
    }
}

# ── Download and extract ──

$Url = "https://github.com/$Repo/releases/download/$Version/$Artifact.zip"
$TmpDir = Join-Path $env:TEMP "codeg-install-$(Get-Random)"
New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
$ZipPath = Join-Path $TmpDir "$Artifact.zip"

Write-Host "Downloading $Url..."
try {
    Invoke-WebRequest -Uri $Url -OutFile $ZipPath -UseBasicParsing
} catch {
    Write-Error "Download failed. Check that version $Version exists and has a $Artifact asset."
    exit 1
}

Write-Host "Extracting..."
Expand-Archive -Path $ZipPath -DestinationPath $TmpDir -Force

# ── Install ──
#
# Verify both binaries are present in the archive BEFORE writing anything
# to InstallDir. Without the companion, delegation degrades silently on
# every new ACP session — fail fast instead.

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

foreach ($name in $ManagedBins) {
    $src = Join-Path $TmpDir $Artifact "$name.exe"
    if (-not (Test-Path $src)) {
        Write-Error "$name.exe not found in archive $Artifact.zip — release is incomplete, please report."
        exit 1
    }
}
foreach ($name in $ManagedBins) {
    $src = Join-Path $TmpDir $Artifact "$name.exe"
    $dst = Join-Path $InstallDir "$name.exe"
    Copy-Item $src -Destination $dst -Force
}
# codeg-computer-helper.exe: computer use, which codeg-server offers only when
# started with CODEG_COMPUTER_USE=1 in a desktop session. Installed when the
# release ships it (older ones do not).
$HelperSrc = Join-Path $TmpDir $Artifact "codeg-computer-helper.exe"
if (Test-Path $HelperSrc) {
    Copy-Item $HelperSrc -Destination (Join-Path $InstallDir "codeg-computer-helper.exe") -Force
}

# Re-canonicalize destination now that the file exists. Pre-install canon may
# leave the final non-existent component unresolved, which would mis-compare
# against the post-install Get-Command result.
$DestBinReal = Get-CanonicalPath $DestBin

# Install web assets
$WebSrc = Join-Path $TmpDir $Artifact "web"
$WebDir = Join-Path $InstallDir "web"
if (Test-Path $WebSrc) {
    Write-Host "Installing web assets to $WebDir..."
    if (Test-Path $WebDir) { Remove-Item $WebDir -Recurse -Force }
    Copy-Item $WebSrc -Destination $WebDir -Recurse
}

# ── Add to PATH ──

$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if (-not (Test-PathHasDir $UserPath $InstallDir)) {
    [Environment]::SetEnvironmentVariable("Path", "$UserPath;$InstallDir", "User")
    Write-Host "Added $InstallDir to user PATH (restart terminal to take effect)"
}
# Mirror the change into the current process so the post-install verification
# below can resolve `codeg-server`. Without this, the first-time install would
# always exit non-zero on Windows because Get-Command runs against the in-process
# $env:Path that does not yet include $InstallDir.
if (-not (Test-PathHasDir $env:Path $InstallDir)) {
    $env:Path = "$env:Path;$InstallDir"
}

# ── Cleanup ──

Remove-Item $TmpDir -Recurse -Force -ErrorAction SilentlyContinue

# ── Remove shadowing binaries from earlier PATH entries ──

$ExitStatus = 0

if ($Cleanup -and $PathConflicts.Count -gt 0) {
    Write-Host ""
    Write-Host "Removing stale codeg-server binaries..."
    foreach ($c in $PathConflicts) {
        try {
            Remove-Item -LiteralPath $c -Force -ErrorAction Stop
            Write-Host "  removed $c"
        } catch {
            Write-Host "  failed to remove $c (remove it manually so 'codeg-server' resolves to the new install) — $($_.Exception.Message)"
            $ExitStatus = 1
        }
    }
}

# ── Move out of the desktop app's folder ──
#
# The server an earlier version of this script installed in $MoveFrom, the
# desktop app's folder, now lives in $InstallDir. Of what is left there only
# codeg-server.exe is the server's: codeg-mcp.exe, codeg-computer-helper.exe
# and web\ are the desktop app's. The folder went on the user PATH for the
# server, and comes off it.

if ($MoveFrom) {
    $OldBin = Join-Path $MoveFrom "codeg-server.exe"
    if ($Cleanup) {
        if (Test-Path -LiteralPath $OldBin) {
            try {
                Remove-Item -LiteralPath $OldBin -Force -ErrorAction Stop
                Write-Host "  removed $OldBin"
            } catch {
                Write-Host "  failed to remove $OldBin (remove it manually) — $($_.Exception.Message)"
                $ExitStatus = 1
            }
        }
        $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (Test-PathHasDir $UserPath $MoveFrom) {
            $Kept = @($UserPath.Split(';') | Where-Object { $_ -and -not (Test-SameDir $_ $MoveFrom) })
            [Environment]::SetEnvironmentVariable("Path", ($Kept -join ';'), "User")
            Write-Host "Removed $MoveFrom from user PATH"
        }
        $env:Path = (@($env:Path.Split(';') | Where-Object { $_ -and -not (Test-SameDir $_ $MoveFrom) }) -join ';')
    } else {
        Write-Host "Keeping $OldBin (-NoCleanup); remove it so 'codeg-server' runs the new install."
    }
    Write-Host ""
    Write-Host "codeg-server moved from $MoveFrom to ${InstallDir}: the codeg desktop app is installed"
    Write-Host "in $MoveFrom, and the two would keep replacing each other's files."
    Write-Host "If a service, scheduled task or shortcut starts $OldBin, or CODEG_STATIC_DIR"
    Write-Host "points to $MoveFrom\web, point it at $InstallDir instead."
}

# ── Restart service if it was running ──

if ($WasRunning) {
    Write-Host ""
    Write-Host "Note: codeg-server was stopped for the upgrade."
    Write-Host "Please restart it manually to ensure your environment variables (CODEG_PORT, CODEG_TOKEN, etc.) are preserved:"
    Write-Host "  `$env:CODEG_STATIC_DIR=`"$WebDir`"; codeg-server"
}

# ── Done ──

$InstalledVer = ""
try {
    $InstalledVer = (& (Join-Path $InstallDir "codeg-server.exe") --version 2>$null).Trim()
} catch {}
if (-not $InstalledVer) { $InstalledVer = $TargetVer }

Write-Host ""
Write-Host "codeg-server installed to $InstallDir\codeg-server.exe"
Write-Host "codeg-mcp    installed to $InstallDir\codeg-mcp.exe"
Write-Host "Version: $InstalledVer"

# Final smoke: codeg-mcp.exe must exist next to codeg-server.exe so the
# runtime's `locate_codeg_mcp_binary()` exe-sibling lookup hits. A failure
# here means the zip was malformed or a previous Copy-Item was silently
# blocked — surface it loudly rather than ship a half-broken install.
$McpPath = Join-Path $InstallDir "codeg-mcp.exe"
if (-not (Test-Path -LiteralPath $McpPath)) {
    Write-Host ""
    Write-Host "Error: $McpPath missing after install."
    Write-Host "       Delegation (sub-agent tooling) will not work. Re-run the installer."
    $ExitStatus = 1
}

# Verify the user's `codeg-server` command actually resolves to the new binary.
$ActiveBinAfter = ""
$resolvedAfter = Get-Command codeg-server -ErrorAction SilentlyContinue
if ($resolvedAfter) { $ActiveBinAfter = $resolvedAfter.Source }
$ActiveBinAfterReal = Get-CanonicalPath $ActiveBinAfter

if (-not $ActiveBinAfter) {
    Write-Host ""
    Write-Host "Note: $InstallDir is not on the current session's PATH."
    Write-Host "Open a new terminal (PATH was just updated) or run:"
    Write-Host "  `$env:Path = `"$InstallDir;`$env:Path`""
    $ExitStatus = 1
} elseif ($ActiveBinAfterReal -ne $DestBinReal) {
    Write-Host ""
    Write-Host "Warning: typing 'codeg-server' still runs $ActiveBinAfter, not $DestBin."
    Write-Host "Another binary earlier in PATH is shadowing the new install. To fix, either:"
    Write-Host "  - re-run without -NoCleanup (the default removes shadowing binaries), or"
    Write-Host "  - remove the stale binary manually: Remove-Item '$ActiveBinAfter', or"
    Write-Host "  - put $InstallDir before its directory in PATH."
    $ExitStatus = 1
}

Write-Host ""
Write-Host "Quick start:"
Write-Host "  `$env:CODEG_STATIC_DIR=`"$WebDir`"; codeg-server"
Write-Host ""
Write-Host "Or with custom settings:"
Write-Host "  `$env:CODEG_PORT=`"3080`"; `$env:CODEG_TOKEN=`"your-secret`"; `$env:CODEG_STATIC_DIR=`"$WebDir`"; codeg-server"

exit $ExitStatus
