# One-shot npm publish for a dsh plugin. Token resolution order:
#   1. $env:NPM_PUBLISH_TOKEN — process, then User scope (User scope reads the
#      registry, so a `setx` value is visible even without restarting the
#      long-running DSH service process that spawns this script).
#   2. $env:NPM_TOKEN — process, then User scope.
#   3. $DSH_HOME/secrets/npm-token.txt
# Never pasted into chat. Temporary .npmrc is deleted afterwards.
# Uses pnpm (npm is not on PATH on this machine).
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $MyInvocation.MyCommand.Path -Parent) -Parent

function Get-Token([string]$name) {
  $process = [Environment]::GetEnvironmentVariable($name)
  if ($process) { return $process.Trim() }
  $user = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($user) { return $user.Trim() }
  return $null
}

$token = Get-Token 'NPM_PUBLISH_TOKEN'
if (-not $token) { $token = Get-Token 'NPM_TOKEN' }
$secrets = Join-Path $env:DSH_HOME 'secrets\npm-token.txt'
if (-not $token -and (Test-Path $secrets)) { $token = (Get-Content $secrets -Raw).Trim() }
if (-not $token) {
  throw 'npm token missing: set it with `setx NPM_PUBLISH_TOKEN "<token>"` (or NPM_TOKEN), or create $DSH_HOME/secrets/npm-token.txt'
}
$npmrc = Join-Path $root '.npmrc'
try {
  Set-Content -Path $npmrc -Value ("//registry.npmjs.org/:_authToken=" + $token) -Encoding ascii
  & pnpm publish --ignore-scripts --no-git-checks 2>&1
  if ($LASTEXITCODE -ne 0) { throw "pnpm publish failed (exit $LASTEXITCODE)" }
  Write-Host 'published — check https://www.npmjs.com/package/dsh-plugin-proxy'
} finally {
  Remove-Item -Force $npmrc -ErrorAction SilentlyContinue
}
