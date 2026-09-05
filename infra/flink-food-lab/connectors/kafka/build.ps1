[CmdletBinding()]
param([string]$MavenRepository = '', [switch]$SkipTests)
$ErrorActionPreference = 'Stop'
if ($MavenRepository) {
    $MavenRepository = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($MavenRepository)
}
$previousJava = $env:JAVA_HOME
$previousPath = $env:PATH
try {
    $env:JAVA_HOME = 'D:\jdk25'
    $env:PATH = "$env:JAVA_HOME\bin;$previousPath"
    if (-not (Test-Path "$env:JAVA_HOME\bin\javac.exe")) { throw 'JDK 25 is required at D:\jdk25' }
    $sourceCommit = '2960af0eb26dfac3e224f5edf1db6f867888c62f'
    $target = Join-Path $PSScriptRoot 'upstream'
    New-Item -ItemType Directory -Force $target | Out-Null
    $archive = Join-Path $target 'upstream.tar.gz'
    if (-not (Test-Path $archive)) {
        Invoke-WebRequest "https://codeload.github.com/apache/flink-connector-kafka/tar.gz/$sourceCommit" -OutFile $archive -TimeoutSec 120
    }
    if ((Get-FileHash $archive -Algorithm SHA256).Hash -ne '3F4C35CFE0F2A54254F595D1383D1EC97E825E7DD89F1F5FDFA4240456E3C5C7') { throw 'Kafka source archive checksum mismatch' }
    & tar -xzf $archive -C $target
    if ($LASTEXITCODE -ne 0) { throw 'Kafka source extraction failed' }
    $mavenArgs = @('-B', '-ntp', '-f', (Join-Path $PSScriptRoot 'pom.xml'), 'clean', 'install')
    if ($MavenRepository) { $mavenArgs += "-Dmaven.repo.local=$MavenRepository" }
    if ($SkipTests) { $mavenArgs += '-DskipTests' }
    & mvn.cmd @mavenArgs
    if ($LASTEXITCODE -ne 0) { throw 'Kafka connector build failed' }
} finally {
    $env:JAVA_HOME = $previousJava
    $env:PATH = $previousPath
}
