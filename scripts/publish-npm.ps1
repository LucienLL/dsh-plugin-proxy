# One-shot npm publish for a dsh plugin. Token is read from the local
# secrets file ($DSH_HOME/secrets/npm-token.txt) or $env:NPM_TOKEN — never
# pasted into chat. Temporary .npmrc is deleted afterwards.
# Uses pnpm (npm is not on PATH on this machine).
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent
$secrets = Join-Path $env:DSH_HOME 'secrets\npm-token.txt'
$token = $env:NPM_TOKEN
if (-not $token -and (Test-Path $secrets)) { $token = (Get-Content $secrets -Raw).Trim() }
if (-not $token) { throw 'npm token missing: set NPM_TOKEN or create $DSH_HOME/secrets/npm-token.txt' }
$npmrc = Join-Path $root '.npmrc'
try {
  Set-Content -Path $npmrc -Value ("//registry.npmjs.org/:_authToken=" + $token) -Encoding ascii
  & pnpm publish --ignore-scripts --no-git-checks 2>&1
  if ($LASTEXITCODE -ne 0) { throw "pnpm publish failed (exit $LASTEXITCODE)" }
  Write-Host 'published — check https://www.npmjs.com/package/dsh-plugin-proxy'
} finally {
  Remove-Item -Force $npmrc -ErrorAction SilentlyContinue
}
