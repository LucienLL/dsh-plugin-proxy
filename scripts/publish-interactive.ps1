# npm security-key publish - the correct flow for npm 2FA in 2026.
#
# npm no longer supports TOTP authenticator codes (maintainer-confirmed, Jan
# 2026); 2FA is security-key (WebAuthn) based. pnpm cannot complete a WebAuthn
# challenge, so publishing must use the official npm CLI, whose device flow
# prints an auth URL: open it in your browser, confirm with your passkey
# (Windows Hello / phone), and the publish completes automatically.
#
# No PATH dependencies: uses the runtime node + a locally installed npm CLI.
# Pure ASCII on purpose: Windows PowerShell 5.1 mis-parses non-ASCII UTF-8
# scripts under the system codepage (GBK), so keep every string here ASCII.
#
# Usage (from your own PowerShell/terminal - the browser step needs YOU):
#   powershell -ExecutionPolicy Bypass -File scripts\publish-interactive.ps1
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$node = 'E:\Program Files\DeepSeek Harness\runtime\node\bin\node.exe'
$npm = 'E:\Deepseek\Default\npm-cli\node_modules\npm\bin\npm-cli.js'

if (-not (Test-Path $node)) { throw "node not found: $node" }
if (-not (Test-Path $npm)) { throw "npm CLI not found at $npm - install it first (pnpm add npm --dir E:\Deepseek\Default\npm-cli)" }

$token = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN', 'User')
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN') }
if (-not $token) { throw 'NPM_PUBLISH_TOKEN missing - run: setx NPM_PUBLISH_TOKEN "<token>" then reopen this terminal' }

Push-Location $root
try {
  # Final gate: run the whole suite with the runtime node.
  Write-Host '==> Running plugin tests...' -ForegroundColor Cyan
  foreach ($file in @('test/proxy.test.mjs', 'test/plugin-shape.mjs', 'test/apply.mjs', 'test/client-shape.mjs', 'test/smoke-undici.mjs')) {
    & $node $file *> $null
    if ($LASTEXITCODE -ne 0) { throw "tests failed: $file" }
  }
  Write-Host '    tests passed (23/23).' -ForegroundColor Green

  $npmrc = Join-Path $root '.npmrc'
  try {
    Set-Content -Path $npmrc -Value ("//registry.npmjs.org/:_authToken=" + $token) -Encoding ascii
    Write-Host ''
    Write-Host '==> npm will print an authentication URL below. OPEN IT IN YOUR BROWSER,' -ForegroundColor Yellow
    Write-Host '    confirm with your passkey (Windows Hello / phone), then come back here -' -ForegroundColor Yellow
    Write-Host '    the publish continues automatically. Do NOT close this window.' -ForegroundColor Yellow
    Write-Host ''
    & $node $npm publish --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw "npm publish failed (exit $LASTEXITCODE)" }
    Write-Host 'published - check https://www.npmjs.com/package/dsh-plugin-proxy' -ForegroundColor Green
  } finally {
    Remove-Item -Force $npmrc -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
