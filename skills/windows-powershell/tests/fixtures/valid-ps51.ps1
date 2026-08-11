[CmdletBinding()]
param(
    [string] $Name = 'world'
)

Set-StrictMode -Version 2.0
$values = @('one', 'two')
Write-Output ('Hello {0}: {1}' -f $Name, ($values -join ', '))
