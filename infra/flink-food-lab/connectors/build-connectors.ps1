[CmdletBinding()]
param([string]$MavenRepository = '', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
if ($MavenRepository) {
    $MavenRepository = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MavenRepository)
}
$argsForBuild = @{ MavenRepository = $MavenRepository; SkipTests = $SkipTests }
& (Join-Path $PSScriptRoot 'kafka\build.ps1') @argsForBuild
& (Join-Path $PSScriptRoot 'starrocks\build.ps1') @argsForBuild
$lib = Join-Path (Split-Path $PSScriptRoot -Parent) 'flink\lib'
New-Item -ItemType Directory -Force $lib | Out-Null
# This directory contains generated connector artifacts only.
Get-ChildItem -LiteralPath $lib -File -Filter '*.jar' | Remove-Item
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'kafka\target\flink-connector-kafka-5.0.0-flink-2.3.0-zev.1-sql.jar') -Destination $lib
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'starrocks\target\flink-connector-starrocks-1.2.15-flink-2.3.0-zev.1.jar') -Destination $lib
$manifest = Get-ChildItem -LiteralPath $lib -Filter '*.jar' | Sort-Object Name | ForEach-Object {
    "$((Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant())  $($_.Name)"
}
[System.IO.File]::WriteAllText((Join-Path $lib 'SHA256SUMS'), (($manifest -join "`n") + "`n"), [System.Text.UTF8Encoding]::new($false))
Write-Host "Flink 2.3 connectors built and verified: $lib"
