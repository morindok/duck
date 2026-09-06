$old = Get-NetTCPConnection -LocalPort 8121 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $old) { if ($p -ne $PID) { Stop-Process -Id $p -Force -ErrorAction SilentlyContinue } }
Start-Sleep -Seconds 1
$log = "$env:TEMP\opencode\duck-proxy.out"
$err = "$env:TEMP\opencode\duck-proxy.err"
Start-Process -FilePath 'node' -ArgumentList 'F:\AI\duck\proxy.js' -WindowStyle Hidden -RedirectStandardOutput $log -RedirectStandardError $err
Start-Sleep -Seconds 3
try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 http://127.0.0.1:8121/health).Content } catch { Write-Output ('HEALTH FAIL: ' + $_.Exception.Message) }
