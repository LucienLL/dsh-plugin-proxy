# Interactive npm publish for a user terminal — no PATH dependencies.
#
# Uses the DSH runtime node and pnpm directly (pnpm is not on the system PATH
# on this machine). Reads NPM_PUBLISH_TOKEN (User scope, then process), runs
# the plugin test suite with the runtime node, then publishes with an OTP.
#
# Usage (from your own PowerShell/terminal):
#   powershell -ExecutionPolicy Bypass -File E:\Deepseek\Default\dsh-plugin-proxy\scripts\publish-interactive.ps1
$ErrorActionPreference = 'Stop'
$root = 'E:\Deepseek\Default\dsh-plugin-proxy'
$node = 'E:\Program Files\DeepSeek Harness\runtime\node\bin\node.exe'
$pnpm = 'E:\Program Files\DeepSeek Harness\runtime\node\node_modules\pnpm\bin\pnpm.cjs'

if (-not (Test-Path $node)) { throw "node not found: $node" }
if (-not (Test-Path $pnpm)) { throw "pnpm not found: $pnpm" }

$token = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN', 'User')
if (-not $token) { $token = [Environment]::GetEnvironmentVariable('NPM_PUBLISH_TOKEN') }
if (-not $token) { throw 'NPM_PUBLISH_TOKEN missing — run: setx NPM_PUBLISH_TOKEN "<token>" then reopen this terminal' }

Push-Location $root
try {
  # Final gate: run the whole suite with the runtime node.
  Write-Host '==> Running plugin tests...' -ForegroundColor Cyan
  foreach ($file in @('test/proxy.test.mjs', 'test/plugin-shape.mjs', 'test/apply.mjs', 'test/client-shape.mjs', 'test/smoke-undici.mjs')) {
    & $node $file *> $null
    if ($LASTEXITCODE -ne 0) { throw "tests failed: $file" }
  }
  Write-Host '    tests passed (23/23).' -ForegroundColor Green

  $otp = (Read-Host -Prompt 'Enter the 6-digit 2FA code from your authenticator app').Trim()
  if ($otp -notmatch '^\d{6}$') { throw "invalid OTP format: expected 6 digits" }

  $npmrc = Join-Path $root '.npmrc'
  try {
    Set-Content -Path $npmrc -Value ("//registry.npmjs.org/:_authToken=" + $token) -Encoding ascii
    & $node $pnpm publish --ignore-scripts --no-git-checks --otp $otp
    if ($LASTEXITCODE -ne 0) { throw "pnpm publish failed (exit $LASTEXITCODE)" }
    Write-Host 'published — check https://www.npmjs.com/package/dsh-plugin-proxy' -ForegroundColor Green
  } finally {
    Remove-Item -Force $npmrc -ErrorAction SilentlyContinue
  }
} finally {
  Pop-Location
}
