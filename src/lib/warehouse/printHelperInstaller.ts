import { stationChromePolicies, stationShortcutArgs } from "./stationSetup";

// The print helper's one-file installer (Cristian, 2026-10-21: "download
// something that installs all the needed things automatically"). A .cmd
// you double-click on the station PC. It's a .cmd that runs the PowerShell
// written after its "exit": cmd never reaches that part, PowerShell reads
// the file and runs from the marker on. The PowerShell:
//   1. finds Python 3.9+ (not the Microsoft Store stub), or installs it
//      quietly for this Windows user from python.org
//   2. pip installs pymupdf, pywin32, pillow for this user (leaving any
//      already there alone: other programs on the PC may use them)
//   3. downloads print_helper.py from the app into %LOCALAPPDATA%\PrintHelper
//   4. adds this station (id + key) to config.json there, keeping any other
//      station a helper on this PC already prints for
//   5. checks in once (so the station page's printer list fills in right
//      away), test-runs the helper here (--check: any error shows in the
//      window and on the station page), then sets it to start at logon,
//      starts it, and makes sure it's still running 12s later
//   6. for a station with a browser (not the Wi-Fi slip printer), does the
//      station page's manual setup too (Cristian, 2026-10-21): the Chrome
//      policies (machine-wide, so one Windows permission prompt), "Let
//      Windows manage my default printer" off, and a desktop shortcut named
//      after the station
// Only step 6's policies need admin. Re-running it updates everything.

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

const POLICY_KEYS = ["HKLM:\\SOFTWARE\\Policies\\Google\\Chrome", "HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge"];

// The part that needs admin, run elevated as an encoded command (no
// quoting to get wrong). Writes the policies for Chrome and Edge, leaving
// any other policy alone: New-Item -Force on an existing registry key
// wipes its values, so the key is only created when it's missing.
function policyScript(origin: string): string {
  const lines: string[] = [];
  for (const key of POLICY_KEYS) {
    const k = psQuote(key);
    lines.push(`if (-not (Test-Path ${k})) { New-Item -Path ${k} -Force | Out-Null }`);
    for (const p of stationChromePolicies(origin)) {
      lines.push(
        p.type === "dword"
          ? `New-ItemProperty -Path ${k} -Name ${psQuote(p.name)} -Value ${p.value} -PropertyType DWord -Force | Out-Null`
          : `New-ItemProperty -Path ${k} -Name ${psQuote(p.name)} -Value ${psQuote(String(p.value))} -PropertyType String -Force | Out-Null`
      );
    }
  }
  return lines.join("\n");
}

export function printHelperInstaller(args: {
  baseUrl: string;
  stationId: string;
  stationName: string;
  token: string;
  // A PC that opens the station page (not the Wi-Fi slip printer).
  browserStation: boolean;
}): string {
  const [printPolicy, hidPolicy] = stationChromePolicies(args.baseUrl);
  const encodedPolicy = Buffer.from(policyScript(args.baseUrl), "utf16le").toString("base64");
  const shortcutName = args.stationName.replace(/[<>:"/\\|?*]/g, "").trim() || "Station";
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
$BrowserStation = ${args.browserStation ? "$true" : "$false"}
$ShortcutName = ${psQuote(shortcutName)}
$ShortcutArgs = ${psQuote(stationShortcutArgs(args.baseUrl, args.stationId))}
$PolicyScript = ${psQuote(encodedPolicy)}
$WantPrintPolicy = ${printPolicy.value}
$WantHidPolicy = ${psQuote(String(hidPolicy.value))}
$Warnings = @()

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
  & $python -m pip install --user --disable-pip-version-check --no-warn-script-location --quiet pymupdf pywin32 pillow
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
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Prints labels and packing slips for the eBay tool stations' -Force | Out-Null
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  # A helper that restarted itself after an update isn't the task's
  # process, so stopping the task leaves it running; the new copy would see
  # it and quit, and the old version would keep printing (Cristian,
  # 2026-10-24: reinstalled 5 times, still the old version). Stop every one.
  Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like '*print_helper.py*' } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2

  # Run it once in this window first: if it can't load or reach the app,
  # the error shows here (and on the station page) instead of the helper
  # dying silently in the background (Cristian, 2026-10-25: Listing Station
  # showed running for a few seconds after each reinstall, then not).
  Write-Host 'Testing the helper...'
  $ErrorActionPreference = 'Continue'
  $out = & $python (Join-Path $Dir 'print_helper.py') --check 2>&1 | Out-String
  $code = $LASTEXITCODE
  $ErrorActionPreference = 'Stop'
  Write-Host $out.Trim()
  # A helper problem doesn't stop the rest: the Chrome settings below are
  # what makes the scale stick, helper or not.
  $HelperOk = $code -eq 0
  if (-not $HelperOk) { $Warnings += "The print helper can't run on this PC (error above, also sent to the app). Send Cristian a picture of this window." }

  if ($HelperOk) { Start-ScheduledTask -TaskName $TaskName; Start-Sleep -Seconds 12 }
  # Then make sure the background copy stays up.
  $alive = @(Get-CimInstance Win32_Process -Filter "Name like 'python%'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*print_helper.py*' })
  if ($HelperOk -and $alive.Count -eq 0) {
    $result = (Get-ScheduledTaskInfo -TaskName $TaskName -ErrorAction SilentlyContinue).LastTaskResult
    $logPath = Join-Path $Dir 'print_helper.log'
    $tail = if (Test-Path $logPath) { (Get-Content -LiteralPath $logPath -Tail 15) -join [Environment]::NewLine } else { '(no log file)' }
    $why = "The helper passed the test but stopped right after starting in the background. Task result: $result. Python: $python" + [Environment]::NewLine + $tail
    try {
      $err = @{ error = $why; version = 'installer' } | ConvertTo-Json
      Invoke-RestMethod "$BaseUrl/api/print-helper/checkin" -Method Post -Body $err -ContentType 'application/json' -Headers @{ Authorization = "Bearer $Token" } | Out-Null
    } catch {}
    Write-Host $tail
    $HelperOk = $false
    $Warnings += 'The print helper stopped right after starting in the background (details above, also sent to the app). Send Cristian a picture of this window.'
  }
  if ($HelperOk) { Write-Host 'The helper is running.' }

  if ($BrowserStation) {
    # Chrome settings for the station (the .reg step on the station page).
    $have = $false
    try {
      $key = 'HKLM:\SOFTWARE\Policies\Google\Chrome'
      $have = ((Get-ItemPropertyValue $key -Name 'PrintPreviewUseSystemDefaultPrinter' -ErrorAction Stop) -eq $WantPrintPolicy) -and ((Get-ItemPropertyValue $key -Name 'WebHidAllowDevicesForUrls' -ErrorAction Stop) -eq $WantHidPolicy)
    } catch {}
    if ($have) {
      Write-Host 'Chrome settings: already set.'
    } else {
      Write-Host 'Saving the Chrome settings for the station. Windows will ask for permission: click Yes.'
      try {
        $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $PolicyScript
        if ($p.ExitCode -ne 0) { throw "it stopped with code $($p.ExitCode)" }
        $saved = $false
        try { $saved = (Get-ItemPropertyValue $key -Name 'WebHidAllowDevicesForUrls' -ErrorAction Stop) -eq $WantHidPolicy } catch {}
        if (-not $saved) { throw 'the scale setting is not there after saving' }
        Write-Host 'Chrome settings: saved.'
      } catch {
        $Warnings += 'The Chrome settings were not saved (permission declined?). Run this again and click Yes, or do the .reg step on the station page.'
      }
    }

    # Windows keeps the default printer you set instead of switching it to
    # the last one used ("Let Windows manage my default printer" off).
    $win = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Windows'
    if (-not (Test-Path $win)) { New-Item -Path $win -Force | Out-Null }
    Set-ItemProperty -Path $win -Name 'LegacyDefaultPrinterMode' -Value 1 -Type DWord

    # The desktop shortcut that opens this station's page.
    $browser = @(
      (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
      (Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Google\Chrome\Application\chrome.exe'),
      (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe')
    ) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if ($browser) {
      $lnk = Join-Path ([Environment]::GetFolderPath('Desktop')) ($ShortcutName + '.lnk')
      $shell = New-Object -ComObject WScript.Shell
      $sc = $shell.CreateShortcut($lnk)
      $sc.TargetPath = $browser
      $sc.Arguments = $ShortcutArgs
      $sc.WorkingDirectory = Split-Path $browser
      $sc.IconLocation = "$browser,0"
      $sc.Description = "Station: $StationName"
      $sc.Save()
      Write-Host "Desktop shortcut: $ShortcutName"
    } else {
      $Warnings += 'Chrome is not installed, so no desktop shortcut was made. Install Chrome and run this again.'
    }
  }

  Write-Host ''
  foreach ($w in $Warnings) { Write-Host $w -ForegroundColor Yellow }
  if ($HelperOk) { Write-Host 'Done.' -ForegroundColor Green } else { Write-Host 'Done, but the print helper is NOT running (see above).' -ForegroundColor Red }
  if ($BrowserStation) {
    Write-Host '1. Close every Chrome window, so the new settings take effect.'
    Write-Host "2. Open the '$ShortcutName' shortcut on the desktop and sign in (first time only)."
    Write-Host '3. On the station page, pick the printer for 4x6 labels.'
  } else {
    Write-Host 'Go back to the station page and pick the printer for 4x6 labels.'
  }
} catch {
  Write-Host ''
  Write-Host "Something went wrong: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host 'Take a picture of this window and send it to Cristian.'
}
`;
  const cmd = [
    "@echo off",
    "title Print helper setup",
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
