# Offline regression: copies build scripts into ignored scratch space and mocks all external commands.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$foodLabRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../..'))
$scratch = Join-Path $foodLabRoot ('flink/verification/target/build-paths-' + [guid]::NewGuid().ToString('N'))
$copyRoot = Join-Path $scratch 'infra/flink-food-lab'
$caller = Join-Path $scratch 'caller with spaces'
$null = New-Item -ItemType Directory -Path $caller -Force
foreach ($relative in @('connectors/build-connectors.ps1', 'connectors/kafka/build.ps1', 'connectors/starrocks/build.ps1', 'flink/build.ps1')) {
    $destination = Join-Path $copyRoot $relative
    $null = New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force
    $contents = Get-Content -LiteralPath (Join-Path $foodLabRoot $relative) -Raw -Encoding UTF8
    if ($relative -eq 'connectors/starrocks/build.ps1') {
        $contents = $contents.Replace("'D:/apache-maven-3.9.12/bin/mvn.cmd'", "'MockMaven'")
        $contents = $contents.Replace('& "$env:JAVA_HOME/bin/java.exe" -version', '& MockJava -version')
    }
    [IO.File]::WriteAllText($destination, $contents, [Text.UTF8Encoding]::new($false))
}
foreach ($artifact in @('kafka/target/flink-connector-kafka-5.0.0-flink-2.3.0-zev.1-sql.jar', 'starrocks/target/flink-connector-starrocks-1.2.15-flink-2.3.0-zev.1.jar')) {
    $destination = Join-Path $copyRoot "connectors/$artifact"
    $null = New-Item -ItemType Directory -Path (Split-Path $destination -Parent) -Force
    [IO.File]::WriteAllText($destination, 'offline fixture')
}
$buildPathState = @{ mavenCalls = [Collections.Generic.List[object]]::new(); dockerCalls = [Collections.Generic.List[object]]::new(); failMaven = $false }
function MockMaven {
    $buildPathState.mavenCalls.Add(@{ arguments = @($args); java = $env:JAVA_HOME; cwd = (Get-Location).Path })
    $global:LASTEXITCODE = if ($buildPathState.failMaven) { 1 } else { 0 }
}
function mvn.cmd { MockMaven @args }
function MockJava { $global:LASTEXITCODE = 0 }
function tar { $global:LASTEXITCODE = 0 }
function docker { $buildPathState.dockerCalls.Add(@($args)); $global:LASTEXITCODE = 0 }
function Invoke-WebRequest {
    param($Uri, $OutFile, $TimeoutSec)
    [IO.File]::WriteAllText($OutFile, 'offline archive fixture')
}
function Get-FileHash {
    param($Path, $Algorithm, $LiteralPath)
    $inputPath = if ($LiteralPath) { $LiteralPath } else { $Path }
    if ($inputPath.EndsWith('upstream.tar.gz')) {
        return @{ Hash = '3F4C35CFE0F2A54254F595D1383D1EC97E825E7DD89F1F5FDFA4240456E3C5C7' }
    }
    Microsoft.PowerShell.Utility\Get-FileHash -LiteralPath $inputPath -Algorithm $Algorithm
}
function Assert-True($condition, [string]$message) { if (-not $condition) { throw $message } }
$priorJava = $env:JAVA_HOME
$priorPath = $env:PATH
$priorEncoding = [Console]::OutputEncoding
Push-Location $caller
try {
    $expectedRepo = Join-Path (Get-Location).Path 'cache with spaces'
    $expectedEnv = Join-Path (Get-Location).Path 'local env.env'
    & (Join-Path $copyRoot 'flink/build.ps1') -MavenRepository './cache with spaces' -EnvironmentFile './local env.env' -SkipTests
    Assert-True ($buildPathState.mavenCalls.Count -eq 2) 'Wrapper must invoke both connector builds.'
    Assert-True ($buildPathState.dockerCalls.Count -eq 1) 'Wrapper must invoke one image build.'
    Assert-True ($buildPathState.dockerCalls[0] -contains $expectedEnv) 'EnvironmentFile must resolve against the PowerShell caller location.'
    foreach ($connector in @('kafka', 'starrocks')) {
        & (Join-Path $copyRoot "connectors/$connector/build.ps1") -MavenRepository './cache with spaces'
    }
    foreach ($call in $buildPathState.mavenCalls) {
        Assert-True ($call.arguments -contains "-Dmaven.repo.local=$expectedRepo") 'All builds must share the caller-relative repository.'
        Assert-True ($call.java.Replace('\', '/') -eq 'D:/jdk25') 'Build must use JDK 25.'
    }
    Assert-True ($env:JAVA_HOME -eq $priorJava -and $env:PATH -eq $priorPath) 'Successful builds must restore caller Java environment.'
    $buildPathState.failMaven = $true
    foreach ($connector in @('kafka', 'starrocks')) {
        $rejected = $false
        try { & (Join-Path $copyRoot "connectors/$connector/build.ps1") -MavenRepository './cache with spaces' } catch { $rejected = $true }
        Assert-True $rejected 'A failed Maven build must propagate failure.'
        Assert-True ($env:JAVA_HOME -eq $priorJava -and $env:PATH -eq $priorPath) 'Failed builds must restore caller Java environment.'
        Assert-True ((Get-Location).Path -eq $caller.Replace('/', '\')) 'Build must restore caller PowerShell location.'
        Assert-True ([Console]::OutputEncoding.CodePage -eq $priorEncoding.CodePage) 'Build must restore caller output encoding.'
    }
    Write-Output 'PASS: wrapper and direct builds resolve caller-relative paths with spaces; success/failure restore Java environment, encoding and cwd. All external commands mocked.'
} finally {
    Pop-Location
    $env:JAVA_HOME = $priorJava
    $env:PATH = $priorPath
    [Console]::OutputEncoding = $priorEncoding
}
