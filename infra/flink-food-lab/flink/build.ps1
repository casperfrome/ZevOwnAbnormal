[CmdletBinding()]
param([string]$EnvironmentFile = '', [string]$MavenRepository = '', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
if ($MavenRepository) {
    $MavenRepository = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MavenRepository)
}
if ($EnvironmentFile) {
    $EnvironmentFile = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($EnvironmentFile)
}
$infraRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..\..'))
& (Join-Path $PSScriptRoot '..\connectors\build-connectors.ps1') -MavenRepository $MavenRepository -SkipTests:$SkipTests
$composeArgs = @('compose', '--project-directory', $infraRoot)
if ($EnvironmentFile) { $composeArgs += @('--env-file', $EnvironmentFile) }
$composeArgs += @('build', 'flink-jobmanager')
& docker @composeArgs
if ($LASTEXITCODE -ne 0) { throw 'Flink image build failed' }
