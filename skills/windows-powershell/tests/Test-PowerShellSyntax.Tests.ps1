[CmdletBinding()]
param()

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$skillRoot = Split-Path -Parent $PSScriptRoot
$scripts = Join-Path $skillRoot 'scripts'
$checker = Join-Path $scripts 'Test-PowerShellSyntax.ps1'
$fixtures = Join-Path $PSScriptRoot 'fixtures'
$engine = (Get-Process -Id $PID).Path

function Invoke-SyntaxCheck {
    param(
        [Parameter(Mandatory = $true)]
        [string] $Fixture
    )

    $fixturePath = Join-Path $fixtures $Fixture
    $output = & $engine -NoProfile -File $checker -Path $fixturePath -AsJson 2>&1
    [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output = ($output -join [Environment]::NewLine)
    }
}

$shared = Invoke-SyntaxCheck -Fixture 'valid-ps51.ps1'
if ($shared.ExitCode -ne 0) {
    throw "Expected the PowerShell 5.1-compatible fixture to pass: $($shared.Output)"
}

$invalid = Invoke-SyntaxCheck -Fixture 'invalid-parser.ps1'
if ($invalid.ExitCode -ne 1) {
    throw "Expected the invalid fixture to fail parsing with exit code 1: $($invalid.Output)"
}

$powerShell7 = Invoke-SyntaxCheck -Fixture 'valid-ps7.ps1'
if ($PSVersionTable.PSVersion.Major -ge 7) {
    if ($powerShell7.ExitCode -ne 0) {
        throw "Expected the PowerShell 7 fixture to pass in PowerShell 7: $($powerShell7.Output)"
    }
} elseif ($powerShell7.ExitCode -ne 1) {
    throw "Expected PowerShell 5.1 to reject PowerShell 7-only syntax: $($powerShell7.Output)"
}

Write-Output "PowerShell syntax checker tests passed on $($PSVersionTable.PSVersion)."
