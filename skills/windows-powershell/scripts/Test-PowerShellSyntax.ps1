[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [Alias('LiteralPath')]
    [string] $Path,

    [switch] $AsJson
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

try {
    $item = Get-Item -LiteralPath $Path -ErrorAction Stop
    if ($item.PSIsContainer) {
        throw "Path is a directory, not a PowerShell script: $Path"
    }

    $tokens = $null
    $parseErrors = $null
    [void] [System.Management.Automation.Language.Parser]::ParseFile(
        $item.FullName,
        [ref] $tokens,
        [ref] $parseErrors
    )
    $parseErrorItems = @($parseErrors)

    $result = [pscustomobject]@{
        valid = ($parseErrorItems.Count -eq 0)
        path = $item.FullName
        powershellVersion = $PSVersionTable.PSVersion.ToString()
        powershellEdition = $PSVersionTable.PSEdition
        errors = @(
            $parseErrorItems | ForEach-Object {
                [pscustomobject]@{
                    message = $_.Message
                    line = $_.Extent.StartLineNumber
                    column = $_.Extent.StartColumnNumber
                    text = $_.Extent.Text
                }
            }
        )
    }

    if ($AsJson) {
        $result | ConvertTo-Json -Depth 5 -Compress
    } elseif ($result.valid) {
        Write-Output "Syntax OK: $($result.path)"
    } else {
        foreach ($parseError in $result.errors) {
            [Console]::Error.WriteLine(
                '{0}:{1}:{2}: {3}' -f
                $result.path,
                $parseError.line,
                $parseError.column,
                $parseError.message
            )
        }
    }

    if (-not $result.valid) {
        exit 1
    }
} catch {
    if ($AsJson) {
        [pscustomobject]@{
            valid = $false
            path = $Path
            powershellVersion = $PSVersionTable.PSVersion.ToString()
            powershellEdition = $PSVersionTable.PSEdition
            errors = @(
                [pscustomobject]@{
                    message = $_.Exception.Message
                    line = $null
                    column = $null
                    text = $null
                }
            )
        } | ConvertTo-Json -Depth 5 -Compress
    } else {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    exit 2
}
