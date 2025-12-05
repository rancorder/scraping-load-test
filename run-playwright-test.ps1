# Playwright Heavy Load Test - PowerShell One-Liner
# VPS 4GB制約でのサイト数限界検証

# === 実行方法 ===
# このファイル全体をコピーしてPowerShellに貼り付け

Write-Host "`n" -NoNewline
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host "Playwright Heavy Load Test" -ForegroundColor Cyan
Write-Host "VPS 4GB Memory Constraint Test" -ForegroundColor Cyan
Write-Host "============================================================" -ForegroundColor Cyan
Write-Host ""

# ステップ1: ディレクトリ確認
if (-not (Test-Path "k6\results")) {
    New-Item -ItemType Directory -Path "k6\results" -Force | Out-Null
}

# ステップ2: アプリビルド
Write-Host "[1/5] Building Playwright test app..." -ForegroundColor Yellow
docker build -f Dockerfile.playwright -t playwright-app:latest .

if ($LASTEXITCODE -ne 0) {
    Write-Host "ERROR: Build failed" -ForegroundColor Red
    Read-Host "Press Enter to exit"
    exit 1
}

# ステップ3: アプリ起動（メモリ制限4GB）
Write-Host "[2/5] Starting app with 4GB memory limit..." -ForegroundColor Yellow
docker run -d --name playwright-test `
    -p 8002:8000 `
    --memory="4g" `
    --memory-swap="4g" `
    playwright-app:latest

Start-Sleep -Seconds 5

# ステップ4: ヘルスチェック
Write-Host "[3/5] Health check..." -ForegroundColor Yellow
try {
    $health = Invoke-WebRequest -Uri "http://localhost:8002/health" -UseBasicParsing
    Write-Host $health.Content -ForegroundColor Green
} catch {
    Write-Host "WARNING: Health check failed" -ForegroundColor Yellow
}

# ステップ5: 負荷試験実行
Write-Host "[4/5] Running load test (10 minutes)..." -ForegroundColor Yellow
Write-Host "Phase 1: Current load (43 sites, 3 min)" -ForegroundColor Cyan
Write-Host "Phase 2: Scaling (60-80 sites, 4 min)" -ForegroundColor Cyan
Write-Host "Phase 3: Limit test (100 sites, 3 min)" -ForegroundColor Cyan
Write-Host ""

docker run --rm --add-host host.docker.internal:host-gateway `
    -v "${PWD}\k6-playwright-test.js:/script.js" `
    -v "${PWD}\k6\results:/results" `
    grafana/k6:latest run /script.js

# ステップ6: 結果表示
Write-Host ""
Write-Host "[5/5] Results Summary:" -ForegroundColor Yellow
Write-Host ""

# メトリクス取得
try {
    $stats = Invoke-WebRequest -Uri "http://localhost:8002/stats" -UseBasicParsing
    $statsData = $stats.Content | ConvertFrom-Json
    
    Write-Host "Memory Usage:" -ForegroundColor Cyan
    Write-Host "  Current: $($statsData.memory_usage_mb) MB" -ForegroundColor White
    Write-Host "  Limit: $($statsData.memory_limit_mb) MB" -ForegroundColor White
    Write-Host "  Usage: $($statsData.memory_usage_percent)%" -ForegroundColor White
    Write-Host ""
    
    Write-Host "Active Tasks:" -ForegroundColor Cyan
    Write-Host "  Total: $($statsData.active_scrapers)" -ForegroundColor White
    Write-Host "  Playwright: $($statsData.playwright_instances)" -ForegroundColor White
    Write-Host ""
} catch {
    Write-Host "Could not fetch stats" -ForegroundColor Yellow
}

# メトリクス詳細
Write-Host "Detailed Metrics:" -ForegroundColor Cyan
try {
    $metrics = Invoke-WebRequest -Uri "http://localhost:8002/metrics" -UseBasicParsing
    $metrics.Content -split "`n" | Select-String "memory_usage_mb|playwright_instances|scrape_requests_total" | Select-Object -First 10
} catch {
    Write-Host "Could not fetch metrics" -ForegroundColor Yellow
}

# クリーンアップ
Write-Host ""
Write-Host "Cleaning up..." -ForegroundColor Yellow
docker stop playwright-test | Out-Null
docker rm playwright-test | Out-Null

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host "COMPLETE!" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Results saved to: k6\results\playwright-load-test.json" -ForegroundColor Cyan
Write-Host ""

# 結果ファイル表示
if (Test-Path "k6\results\playwright-load-test.json") {
    Write-Host "Test Summary:" -ForegroundColor Cyan
    Get-Content "k6\results\playwright-load-test.json" | ConvertFrom-Json | ConvertTo-Json -Depth 10
}

Write-Host ""
Read-Host "Press Enter to exit"
