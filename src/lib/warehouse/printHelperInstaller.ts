// The print helper's one-file installer (Cristian, 2026-10-21: "download
// something that installs all the needed things automatically"). A .cmd
// you double-click on the station PC. It's a .cmd that runs the PowerShell
// written after its "exit": cmd never reaches that part, PowerShell reads
// the file and runs from the marker on. The PowerShell:
//   1. finds Python 3.9+ (not the Microsoft Store stub), or installs it
//      quietly for this Windows user from python.org
//   2. pip installs pymupdf, pywin32, pillow for this user
//   3. downloads print_helper.py from the app into %LOCALAPPDATA%\PrintHelper
//   4. adds this station (id + key) to config.json there, keeping any other
//      station a helper on this PC already prints for
//   5. checks in once (so the station page's printer list fills in right
//      away), then sets it to start at logon and starts it now
// No admin rights needed. Re-running it updates everything.

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

export function printHelperInstaller(args: { baseUrl: string; stationId: string; stationName: string; token: string }): string {
  const ps = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$BaseUrl = ${psQuote(args.baseUrl)}
$StationId = ${psQuote(args.stationId)}
$StationName = ${psQuote(args.stationName)}
$Token = ${psQuote(args.token)}
$Dir = Join-Path $env:LOCALAPPDATA 'PrintHelper'
$TaskName = 'Print Helper'

function Find-Python {
  $found = @()
  if (Get-Command py.exe -ErrorAction SilentlyContinue) {
    try { $p = (& py.exe -3 -c "import sys; print(sys.executable)" 2>$null); if ($LASTEXITCODE -eq 0 -and $p) { $found += "$p".Trim() } } catch {}
  }
  foreach ($c in @(Get-Command python.exe -All -ErrorAction SilentlyContinue)) {
    if ($c.Source -notlike '*WindowsApps*') { $found += $c.Source }
  }
  $found += @(Get-ChildItem "$env:LOCALAPPDATA\Programs\Python\Python3*\python.exe", "$env:ProgramFiles\Python3*\python.exe" -ErrorAction SilentlyContinue | Sort-Object FullName -Descending | ForEach-Object { $_.FullName })
  foreach ($c in $found) {
    if ($c -and (Test-Path $c)) {
      try { $ok = (& $c -c "import sys; print(sys.version_info >= (3, 9))" 2>$null); if ("$ok".Trim() -eq 'True') { return $c } } catch {}
    }
  }
  return $null
}

try {
  Write-Host "Setting up the print helper for station: $StationName" -ForegroundColor Cyan
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null

  $python = Find-Python
  if (-not $python) {
    Write-Host 'Installing Python (one time, about a minute)...'
    $exe = Join-Path $env:TEMP 'python-3.12.7-amd64.exe'
    Invoke-WebRequest 'https://www.python.org/ftp/python/3.12.7/python-3.12.7-amd64.exe' -OutFile $exe -UseBasicParsing
    $p = Start-Process $exe -ArgumentList '/quiet', 'InstallAllUsers=0', 'PrependPath=1', 'Include_launcher=1', 'Include_test=0' -Wait -PassThru
    if ($p.ExitCode -ne 0) { throw "The Python installer stopped with code $($p.ExitCode)." }
    $python = Find-Python
    if (-not $python) { throw 'Python did not install.' }
  }
  Write-Host "Python: $python"

  Write-Host 'Installing the printing libraries...'
  & $python -m pip install --user --upgrade --disable-pip-version-check --quiet pymupdf pywin32 pillow
  if ($LASTEXITCODE -ne 0) { throw 'Installing the libraries (pip) failed.' }

  Write-Host 'Downloading the helper...'
  Invoke-WebRequest "$BaseUrl/print-helper/print_helper.py" -OutFile (Join-Path $Dir 'print_helper.py') -UseBasicParsing

  # This station's key, keeping any other station this PC already prints for.
  $cfgPath = Join-Path $Dir 'config.json'
  $others = @()
  if (Test-Path $cfgPath) {
    try {
      $old = Get-Content -LiteralPath $cfgPath -Raw | ConvertFrom-Json
      if ($old.PSObject.Properties.Name -contains 'stations') { $others = @($old.stations | Where-Object { $_.station_id -ne $StationId }) }
    } catch {}
  }
  $stations = @($others) + @([pscustomobject]@{ station_id = $StationId; name = $StationName; token = $Token })
  $json = [pscustomobject]@{ base_url = $BaseUrl; stations = $stations } | ConvertTo-Json -Depth 5
  [System.IO.File]::WriteAllText($cfgPath, $json)

  # Check in once, so the printer list shows on the station page right away.
  $printers = @(Get-Printer | ForEach-Object { $_.Name })
  $body = @{ printers = $printers; version = 'installer' } | ConvertTo-Json
  Invoke-RestMethod "$BaseUrl/api/print-helper/checkin" -Method Post -Body $body -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } | Out-Null

  Write-Host 'Setting it to start when you sign in to Windows...'
  $pythonw = Join-Path (Split-Path $python) 'pythonw.exe'
  if (-not (Test-Path $pythonw)) { $pythonw = $python }
  $action = New-ScheduledTaskAction -Execute $pythonw -Argument ('"' + (Join-Path $Dir 'print_helper.py') + '"') -WorkingDirectory $Dir
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Prints 4x6 labels and packing slips for the eBay tool stations' -Force | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Start-Sleep -Seconds 2
  Start-ScheduledTask -TaskName $TaskName

  Write-Host ''
  Write-Host 'Done. Go back to the station page and pick the printer for 4x6 labels.' -ForegroundColor Green
} catch {
  Write-Host ''
  Write-Host "Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Take a picture of this window and send it to Cristian.'
}
`;
  const cmd = [
    "@echo off",
    `title Print helper setup`,
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "$s = Get-Content -LiteralPath '%~f0' -Raw; $i = $s.IndexOf('#' + 'PS-START'); Invoke-Expression $s.Substring($i)"`,
    "echo.",
    "pause",
    "exit /b",
    "#PS-START",
    ps.trim(),
    "",
  ].join("\r\n");
  return cmd.replace(/\r?\n/g, "\r\n");
}
