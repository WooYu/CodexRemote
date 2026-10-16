param(
  [string]$ListenAddress = '127.0.0.1',
  [int]$Port = 8789,
  [switch]$Demo,
  [switch]$Structured
)
$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$env:HOST = $ListenAddress
$env:PORT = "$Port"
if ($Demo) { node server.mjs --demo } elseif ($Structured) { node server.mjs } else { node server.mjs --terminal }
