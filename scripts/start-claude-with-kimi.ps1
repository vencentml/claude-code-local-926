$ErrorActionPreference = 'Stop'

$repoRoot = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $repoRoot '.env.kimi'

if (-not (Test-Path $envFile)) {
  throw "Missing .env.kimi. Copy .env.kimi.example to .env.kimi and fill in your local Kimi settings."
}

Get-Content $envFile | ForEach-Object {
  $line = $_.Trim()
  if (-not $line -or $line.StartsWith('#')) { return }
  $parts = $line -split '=', 2
  if ($parts.Count -ne 2) { return }
  $name = $parts[0].Trim()
  $value = $parts[1].Trim()
  [System.Environment]::SetEnvironmentVariable($name, $value, 'Process')
}

if (-not $env:KIMI_API_KEY) {
  throw "KIMI_API_KEY is required in .env.kimi"
}

if (-not $env:ANTHROPIC_PROXY_PORT) {
  $env:ANTHROPIC_PROXY_PORT = '3456'
}

$proxyScript = Join-Path $repoRoot 'scripts\kimi-anthropic-proxy.mjs'
$cliScript = Join-Path $repoRoot 'package\cli.js'

$proxyProcess = Start-Process node `
  -ArgumentList @($proxyScript) `
  -WorkingDirectory $repoRoot `
  -PassThru `
  -WindowStyle Hidden

try {
  $healthUrl = "http://127.0.0.1:$($env:ANTHROPIC_PROXY_PORT)/healthz"
  $ready = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    try {
      $null = Invoke-RestMethod -Uri $healthUrl -Method Get
      $ready = $true
      break
    } catch {
    }
  }

  if (-not $ready) {
    throw "Local Kimi proxy did not become ready at $healthUrl"
  }

  $env:ANTHROPIC_BASE_URL = "http://127.0.0.1:$($env:ANTHROPIC_PROXY_PORT)"
  if (-not $env:ANTHROPIC_CUSTOM_MODEL_OPTION -and $env:KIMI_MODEL) {
    $env:ANTHROPIC_CUSTOM_MODEL_OPTION = $env:KIMI_MODEL
  }
  if (-not $env:ANTHROPIC_MODEL -and $env:KIMI_MODEL) {
    $env:ANTHROPIC_MODEL = $env:KIMI_MODEL
  }
  if (-not $env:ANTHROPIC_API_KEY) {
    $env:ANTHROPIC_API_KEY = 'local-kimi-proxy'
  }

  & node $cliScript @args
  $exitCode = $LASTEXITCODE
  exit $exitCode
} finally {
  if ($proxyProcess -and -not $proxyProcess.HasExited) {
    Stop-Process -Id $proxyProcess.Id -Force
  }
}

