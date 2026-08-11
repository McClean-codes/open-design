[CmdletBinding()]
param(
    [string] $Value
)

$resolved = $Value ?? 'PowerShell 7'
Write-Output $resolved
