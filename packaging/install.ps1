<#
.SYNOPSIS
    Installs the tokencount CLI on Windows.

.DESCRIPTION
    Downloads the release archive for this machine's architecture together with
    the release's SHA256SUMS file, verifies the archive against it, and only
    then unpacks the binary into the install directory. A checksum mismatch
    aborts the install with a non-zero exit code and leaves nothing behind.

.EXAMPLE
    irm https://tokencount.eordano.com/packaging/install.ps1 | iex

.EXAMPLE
    & ([scriptblock]::Create((irm https://tokencount.eordano.com/packaging/install.ps1))) -Version 1.0.1

.NOTES
    Environment variables are honoured for the piped-to-iex form, where
    parameters cannot be passed: TOKENCOUNT_VERSION, TOKENCOUNT_BIN_DIR,
    TOKENCOUNT_REPO.
#>
param(
    [string] $Version = $(if ($env:TOKENCOUNT_VERSION) { $env:TOKENCOUNT_VERSION } else { 'latest' }),
    [string] $BinDir  = $(if ($env:TOKENCOUNT_BIN_DIR) { $env:TOKENCOUNT_BIN_DIR } else { '' }),
    [string] $Repo    = $(if ($env:TOKENCOUNT_REPO)    { $env:TOKENCOUNT_REPO }    else { 'eordano/tokencount' }),
    [switch] $NoModifyPath
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest's progress bar costs more wall time than the download.
$ProgressPreference = 'SilentlyContinue'

$BinName = 'tokencount'
$UserAgent = 'tokencount-install.ps1'

function Write-Info([string] $Message) {
    Write-Host "tokencount: $Message"
}

function Stop-WithError([string] $Message) {
    Write-Host "tokencount: error: $Message" -ForegroundColor Red
    exit 1
}

if ($PSVersionTable.PSVersion.Major -lt 5) {
    Stop-WithError "PowerShell 5.1 or newer is required (found $($PSVersionTable.PSVersion))."
}

# Windows PowerShell 5.1 still negotiates TLS 1.0 by default; GitHub requires
# TLS 1.2 or better, so opt in before the first request.
try {
    [Net.ServicePointManager]::SecurityProtocol =
        [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch {
    Stop-WithError "could not enable TLS 1.2: $($_.Exception.Message)"
}

# --- platform detection -----------------------------------------------------

function Get-TargetTriple {
    # PROCESSOR_ARCHITEW6432 is set when a 32-bit process runs on a 64-bit OS,
    # where PROCESSOR_ARCHITECTURE would misreport x86.
    $arch = $env:PROCESSOR_ARCHITEW6432
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }

    switch ($arch) {
        'AMD64' { return 'x86_64-pc-windows-msvc' }
        'ARM64' {
            # No native aarch64-pc-windows-msvc release yet. Windows 11 on ARM
            # runs the x64 build under emulation, so install that and say so.
            Write-Info 'no native ARM64 build yet; installing the x64 build (runs under emulation)'
            return 'x86_64-pc-windows-msvc'
        }
        default {
            Stop-WithError @"
unsupported processor architecture: $arch.
  Prebuilt Windows binaries are 64-bit only.
  Build one instead -- there is no 'cargo install tokencount', because the
  crate is not on crates.io and build.rs needs the vendor tokenizer tables.
  From a clone:
    node scripts/fetch-models.mjs .\models
    `$env:TOKEN_COUNT_MODELS = '.\models'; cargo build --release --locked
"@
        }
    }
}

# --- version resolution -----------------------------------------------------

function Resolve-LatestVersion {
    try {
        $release = Invoke-RestMethod -UseBasicParsing -UserAgent $UserAgent `
            -Uri "https://api.github.com/repos/$Repo/releases/latest"
    } catch {
        Stop-WithError @"
could not determine the latest release of $Repo ($($_.Exception.Message)).
  Either the repository has no published release yet, or the GitHub API
  rate-limited this unauthenticated request. Pass -Version <x.y.z> to skip
  the lookup.
"@
    }
    if (-not $release.tag_name) {
        Stop-WithError "the latest release of $Repo has no tag name."
    }
    # Tags are "v1.0.1"; asset names use the bare version.
    return ($release.tag_name -replace '^v', '')
}

# --- verification -----------------------------------------------------------

function Get-ExpectedSha256([string] $SumsPath, [string] $AssetName) {
    foreach ($line in (Get-Content -LiteralPath $SumsPath)) {
        # coreutils format: "<hex>  <name>" (text) or "<hex> *<name>" (binary).
        if ($line -match '^\s*([0-9a-fA-F]{64})\s+\*?(\S.*?)\s*$') {
            if ($Matches[2] -ceq $AssetName) {
                return $Matches[1].ToLowerInvariant()
            }
        }
    }
    return $null
}

# SHA256SUMS ships in the same release as the archive, so matching it proves the
# download arrived intact -- not that the release itself is genuine. The build
# provenance attestation is the stronger claim, so check it when the tooling to
# do so is already present and usable. Absent or logged-out gh is a note, not a
# failure; a gh that can check and says no is fatal.
function Test-Attestation([string] $Path) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if (-not $gh) {
        Write-Info 'note: install the GitHub CLI and re-run to also verify build provenance'
        return
    }
    & gh auth status *> $null
    if ($LASTEXITCODE -ne 0) {
        Write-Info "note: 'gh auth login' would let this script also verify build provenance"
        return
    }
    & gh attestation verify $Path --repo $Repo *> $null
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError @"
build provenance verification failed for $(Split-Path -Leaf $Path).
  This archive does not carry an attestation from $Repo's release workflow.
  Nothing was installed. Do not use this download.
"@
    }
    Write-Info 'build provenance verified'
}

# --- PATH -------------------------------------------------------------------

function Add-ToUserPath([string] $Directory) {
    $key = 'HKCU:\Environment'
    $item = Get-Item -LiteralPath $key
    # Read the raw value so an existing REG_EXPAND_SZ entry such as
    # %USERPROFILE%\bin is not silently baked into a literal string.
    $current = $item.GetValue('Path', '', 'DoNotExpandEnvironmentNames')
    # A profile with no user Path value at all makes GetValueKind throw.
    try { $kind = $item.GetValueKind('Path') } catch { $kind = 'ExpandString' }

    $entries = @($current -split ';' | Where-Object { $_ -ne '' })
    foreach ($entry in $entries) {
        if ($entry.TrimEnd('\') -ieq $Directory.TrimEnd('\')) {
            return $false
        }
    }

    $updated = (@($entries) + $Directory) -join ';'
    if ($kind -eq 'ExpandString') {
        Set-ItemProperty -LiteralPath $key -Name Path -Value $updated -Type ExpandString
    } else {
        Set-ItemProperty -LiteralPath $key -Name Path -Value $updated -Type String
    }

    # Tell already-running shells and Explorer that the environment changed.
    # Best effort: if the P/Invoke shim cannot be compiled, the user just has to
    # open a new terminal, which the caller prints anyway.
    try {
        if (-not ('TokenCount.Native' -as [type])) {
            Add-Type -Namespace TokenCount -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true, CharSet = System.Runtime.InteropServices.CharSet.Auto)]
public static extern System.IntPtr SendMessageTimeout(System.IntPtr hWnd, uint Msg, System.UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out System.UIntPtr lpdwResult);
'@
        }
        $result = [System.UIntPtr]::Zero
        # HWND_BROADCAST = 0xffff, WM_SETTINGCHANGE = 0x1a, SMTO_ABORTIFHUNG = 0x2
        [void][TokenCount.Native]::SendMessageTimeout(
            [System.IntPtr]0xffff, 0x1a, [System.UIntPtr]::Zero, 'Environment', 0x2, 5000, [ref] $result)
    } catch {
        Write-Info 'could not broadcast the PATH change; open a new terminal to pick it up'
    }
    return $true
}

# --- main -------------------------------------------------------------------

$target = Get-TargetTriple

if ($Version -eq 'latest') {
    $Version = Resolve-LatestVersion
}
$Version = $Version -replace '^v', ''

if (-not $BinDir) {
    $BinDir = Join-Path $env:LOCALAPPDATA 'Programs\tokencount\bin'
}

$asset = "$BinName-$Version-$target.zip"
$base = "https://github.com/$Repo/releases/download/v$Version"

$work = Join-Path ([System.IO.Path]::GetTempPath()) ("tokencount-install-" + [System.Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work -Force | Out-Null

try {
    $archivePath = Join-Path $work $asset
    $sumsPath = Join-Path $work 'SHA256SUMS'

    Write-Info "downloading $asset"
    try {
        Invoke-WebRequest -UseBasicParsing -UserAgent $UserAgent -Uri "$base/$asset" -OutFile $archivePath
        Invoke-WebRequest -UseBasicParsing -UserAgent $UserAgent -Uri "$base/SHA256SUMS" -OutFile $sumsPath
    } catch {
        Stop-WithError "download failed: $($_.Exception.Message)"
    }

    $expected = Get-ExpectedSha256 -SumsPath $sumsPath -AssetName $asset
    if (-not $expected) {
        Stop-WithError "$asset is not listed in SHA256SUMS for v$Version -- refusing to install"
    }
    $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $expected) {
        Stop-WithError @"
checksum mismatch for $asset
  expected $expected
  got      $actual
  Nothing was installed. Do not use this download.
"@
    }
    Write-Info 'sha256 verified'

    Test-Attestation -Path $archivePath

    $unpack = Join-Path $work 'unpack'
    Expand-Archive -LiteralPath $archivePath -DestinationPath $unpack -Force
    $exeSource = Join-Path $unpack "$BinName.exe"
    if (-not (Test-Path -LiteralPath $exeSource)) {
        Stop-WithError "$asset did not contain $BinName.exe"
    }

    New-Item -ItemType Directory -Path $BinDir -Force | Out-Null
    $exeTarget = Join-Path $BinDir "$BinName.exe"
    try {
        Copy-Item -LiteralPath $exeSource -Destination $exeTarget -Force
    } catch {
        Stop-WithError @"
could not write $exeTarget ($($_.Exception.Message)).
  If tokencount is currently running, close it and try again.
"@
    }

    # Strip the mark-of-the-web if one was attached, so SmartScreen does not
    # prompt on every invocation. Invoke-WebRequest does not set one today, but
    # this costs nothing and survives that changing.
    try { Unblock-File -LiteralPath $exeTarget } catch { }

    # A native command's non-zero exit does not raise, so check it explicitly:
    # an installed binary that cannot run is a failed install.
    $reported = & $exeTarget --version 2>&1
    if ($LASTEXITCODE -ne 0) {
        Stop-WithError @"
installed $exeTarget but it does not run:
  $reported
"@
    }
    Write-Info "installed $exeTarget ($reported)"

    if ($NoModifyPath) {
        Write-Info "PATH not modified; add $BinDir yourself to run tokencount by name"
    } else {
        if (Add-ToUserPath -Directory $BinDir) {
            Write-Info "added $BinDir to your user PATH -- open a new terminal to use it"
        }
    }
} finally {
    Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}
