# Starts the slip printer at logon (Task Scheduler), and right now.
# Run once: powershell -ExecutionPolicy Bypass -File install_startup.ps1
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pythonw = (Get-Command pythonw.exe).Source
$action = New-ScheduledTaskAction -Execute $pythonw -Argument "`"$here\run_slip_printer.pyw`"" -WorkingDirectory $here
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 99 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName "Slip Printer" -Action $action -Trigger $trigger -Settings $settings -Description "Prints eBay tool packing slips on the Wi-Fi Rollo (ebay-listing-tool/tools/slip-printer)" -Force | Out-Null
Start-ScheduledTask -TaskName "Slip Printer"
Write-Host "Slip Printer task installed and started."
