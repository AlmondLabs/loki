param([switch]$Nightly)

# Run through iex, `exit` would close the person's PowerShell window, so failures return $false and the end of the
# script decides how to report them.
function Install-Loki {
  param([bool]$Nightly)

  $ErrorActionPreference = "Stop"
  # PowerShell 5.1's progress bar slows Invoke-WebRequest many times over.
  $ProgressPreference = "SilentlyContinue"

  function Write-Failure([string]$What, [string]$Next) {
    Write-Host $What -ForegroundColor Red
    Write-Host $Next
  }

  if ($PSVersionTable.PSEdition -eq "Core" -and -not $IsWindows) {
    Write-Failure "This script installs loki on Windows." "On macOS or Linux, run this in a terminal: curl -fsSL https://almondlabs.github.io/loki/install.sh | sh"
    return $false
  }
  if (-not [Environment]::Is64BitOperatingSystem) {
    Write-Failure "loki for Windows runs on 64-bit Windows only." "Use loki on a 64-bit Windows machine, a Mac, or Linux."
    return $false
  }

  $channel = if ($Nightly) { "nightly" } elseif ($env:LOKI_CHANNEL) { $env:LOKI_CHANNEL } else { "stable" }
  $releases = if ($env:LOKI_DOWNLOAD_URL) { $env:LOKI_DOWNLOAD_URL } else { "https://github.com/AlmondLabs/loki/releases" }
  switch ($channel) {
    "stable" {
      $base = "$releases/latest/download"; $name = "loki"
      $notPublishedNext = 'For loki Nightly, run $env:LOKI_CHANNEL = "nightly" and then the line again, or download loki from https://github.com/AlmondLabs/loki/releases.'
    }
    "nightly" {
      $base = "$releases/download/nightly"; $name = "loki Nightly"
      $notPublishedNext = "Run the line again in a few minutes, or download loki from https://github.com/AlmondLabs/loki/releases."
    }
    default {
      Write-Failure "Unknown channel: $channel." "Set LOKI_CHANNEL to stable or nightly, or leave it out."
      return $false
    }
  }

  if (Get-Process -Name loki -ErrorAction SilentlyContinue) {
    Write-Failure "loki is open, so it can't be replaced." "Quit loki, then run the line again."
    return $false
  }

  # Windows PowerShell 5.1 may still offer only TLS 1.0, which GitHub refuses.
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

  $setup = Join-Path ([IO.Path]::GetTempPath()) "loki-setup-$([Guid]::NewGuid()).exe"
  try {
    Write-Host "Downloading the latest $name."
    try {
      Invoke-WebRequest -Uri "$base/loki-windows-x64-setup.exe" -OutFile $setup -UseBasicParsing
    } catch {
      # A 404 is a release that doesn't carry the file yet, not a connection problem. Windows PowerShell's exception
      # carries an HttpWebResponse and PowerShell 7's an HttpResponseMessage; both have a StatusCode.
      $response = $_.Exception.Response
      if ($response -and [int]$response.StatusCode -eq 404) {
        Write-Failure "The latest $name isn't published yet." $notPublishedNext
      } else {
        Write-Failure "Couldn't download $base/loki-windows-x64-setup.exe." "Check your internet connection, then run the line again."
      }
      return $false
    }

    Write-Host "Installing loki."
    try {
      $process = Start-Process -FilePath $setup -ArgumentList "/S" -Wait -PassThru
    } catch {
      Write-Failure "Windows wouldn't run the loki setup: $($_.Exception.Message)" "If Smart App Control or your antivirus blocked it, tell us at https://github.com/AlmondLabs/loki/issues."
      return $false
    }
    if ($process.ExitCode -ne 0) {
      Write-Failure "The loki setup stopped with code $($process.ExitCode)." "Quit loki if it's open, then run the line again."
      return $false
    }

    # The setup installs for this user alone, into Programs\loki, and lists itself under a key named for a GUID with
    # the display name "loki <version>". The Tauri loki's key was named loki, and the setup removes it.
    $folder = Join-Path $env:LOCALAPPDATA "Programs\loki"
    $exe = Join-Path $folder "loki.exe"
    $entry = Get-ChildItem -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall" -ErrorAction SilentlyContinue |
      Get-ItemProperty -ErrorAction SilentlyContinue |
      Where-Object { $_.PSChildName -ne "loki" -and $_.DisplayName -match '^loki \d' } |
      Select-Object -First 1
    if ($entry -and $entry.DisplayIcon) {
      $exe = ($entry.DisplayIcon -replace ',-?\d+$', '').Trim('"')
      $folder = Split-Path -Parent $exe
    }
    if (-not (Test-Path $exe)) {
      Write-Failure "The setup finished, but loki isn't at $exe." "Run the line again; if it fails again, tell us at https://github.com/AlmondLabs/loki/issues."
      return $false
    }
    if (-not $entry) {
      Write-Failure "The setup finished, but Windows doesn't list loki under Installed apps." "Run the line again; if it fails again, tell us at https://github.com/AlmondLabs/loki/issues."
      return $false
    }

    if ($env:LOKI_NO_OPEN -eq "1") {
      Write-Host "Done. loki is in $folder."
    } else {
      Start-Process -FilePath $exe
      Write-Host "Done. loki is open."
    }
    return $true
  } finally {
    Remove-Item -Path $setup -Force -ErrorAction SilentlyContinue
  }
}

if (-not (Install-Loki -Nightly $Nightly.IsPresent)) {
  # Run as a file, the exit code tells the caller; run through iex, $LASTEXITCODE does.
  if ($PSCommandPath) { exit 1 } else { $global:LASTEXITCODE = 1 }
}
