# Pack project (no node_modules / .env / data) and upload to remote Linux server.
# Usage:
#   .\scripts\upload-to-server.ps1 -User ubuntu -Host 1.2.3.4
#   .\scripts\upload-to-server.ps1 -User root -Host 1.2.3.4 -RemoteDir /opt/polymarket-bot -Port 22

param(
  [Parameter(Mandatory = $true)]
  [string]$User,

  [Parameter(Mandatory = $true)]
  [string]$HostName,

  [string]$RemoteDir = "/opt/polymarket-bot",
  [int]$Port = 22,
  [switch]$SkipUpload
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Archive = Join-Path $Root "deploy.tgz"

Push-Location $Root
try {
  if (Test-Path $Archive) { Remove-Item $Archive -Force }

  Write-Host ">> Packing $Root -> deploy.tgz (exclude node_modules, .env, data) ..."
  tar -czf deploy.tgz `
    --exclude=node_modules `
    --exclude=.env `
    --exclude=data `
    --exclude=deploy.tgz `
    --exclude=deploy.zip `
    --exclude=.git `
    .

  $sizeMb = [math]::Round((Get-Item $Archive).Length / 1MB, 2)
  Write-Host ">> Archive ready: deploy.tgz (${sizeMb} MB)"

  if ($SkipUpload) {
    Write-Host ">> SkipUpload set; done."
    exit 0
  }

  $target = "${User}@${HostName}:${RemoteDir}/"
  Write-Host ">> Uploading to $target (port $Port) ..."
  ssh -p $Port -o BatchMode=yes "${User}@${HostName}" "mkdir -p '$RemoteDir'"
  if ($LASTEXITCODE -ne 0) {
    throw "SSH failed (exit $LASTEXITCODE). Configure key: ssh-copy-id -p $Port ${User}@${HostName}"
  }
  scp -P $Port $Archive "${User}@${HostName}:${RemoteDir}/deploy.tgz"
  if ($LASTEXITCODE -ne 0) {
    throw "SCP failed (exit $LASTEXITCODE). Archive kept at: $Archive"
  }

  Write-Host ""
  Write-Host ">> Upload complete. Run on server:"
  Write-Host @"

ssh -p $Port ${User}@${HostName}
cd $RemoteDir
tar -xzf deploy.tgz
cp .env.example .env && nano .env    # fill BOT_API_TOKEN etc.
npm install
npm test
node bot.js                           # or use systemd (see docs)

"@ -ForegroundColor Cyan
}
finally {
  Pop-Location
}
