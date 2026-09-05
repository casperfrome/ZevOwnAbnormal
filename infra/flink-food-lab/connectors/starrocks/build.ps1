[CmdletBinding()]
param([switch]$PackageOnly, [string]$MavenRepository, [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
if ($MavenRepository) {
    $MavenRepository = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MavenRepository)
}
$previousJava = $env:JAVA_HOME
$previousPath = $env:PATH
$previousEncoding = [Console]::OutputEncoding
$maven = 'D:/apache-maven-3.9.12/bin/mvn.cmd'
Push-Location $PSScriptRoot
try {
    $env:JAVA_HOME = 'D:/jdk25'
    $env:PATH = "$env:JAVA_HOME/bin;$previousPath"
    [Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
    & "$env:JAVA_HOME/bin/java.exe" -version
    $goal = if ($PackageOnly) { 'verify' } else { 'install' }
    $mavenArgs = @('--batch-mode', '--no-transfer-progress', '-Duser.language=en', '-Duser.country=US')
    if ($MavenRepository) { $mavenArgs += "-Dmaven.repo.local=$MavenRepository" }
    if ($SkipTests) { $mavenArgs += '-DskipTests' }
    & $maven @mavenArgs clean $goal
    if ($LASTEXITCODE -ne 0) { throw "StarRocks connector build failed: $LASTEXITCODE" }
} finally {
    Pop-Location
    $env:JAVA_HOME = $previousJava
    $env:PATH = $previousPath
    [Console]::OutputEncoding = $previousEncoding
}
