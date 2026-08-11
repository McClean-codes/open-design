# Quoting and parsing

Use this reference when a command contains interpolation, metacharacters,
here-strings, nested commands, or data that PowerShell could parse as syntax.

## Choose the smallest quoting surface

- Use single quotes for literal strings. A single quote inside a single-quoted
  string is doubled: `'don''t'`.
- Use double quotes only when `$variable`, `$($expression)`, or escape-sequence
  expansion is intentional.
- Use the format operator for mixed literal and dynamic text when interpolation
  becomes hard to audit: `'File: {0}' -f $path`.
- Quote URLs that contain `&`, `?`, or `#` so PowerShell does not interpret
  metacharacters.
- Do not add backslashes before quotes as if PowerShell used Bash or JSON
  escaping. PowerShell's escape character is the backtick, but prefer changing
  the quoting shape over stacking backticks.

## Keep code and data separate

Pass user or discovered values through variables and parameters. Do not splice
them into a command string and do not call `Invoke-Expression`.

```powershell
$args = @('--output', $outputPath, '--name', $userValue)
& $executable @args
```

For cmdlets, use named parameters directly:

```powershell
Get-ChildItem -LiteralPath $root -File -ErrorAction Stop
```

## Here-strings

Use a here-string only for genuine multiline data. The opening marker must be
the last token on its line, and the closing marker must begin at column 1.

```powershell
$literal = @'
$name is not expanded here.
'@

$expanded = @"
$name is expanded here.
"@
```

Do not translate a Bash `<<EOF` heredoc token by token. For structured data,
prefer an object plus a serializer. For a generated script, write a `.ps1`
file with the file tool and run the Parser check before execution.

## Native quoting boundary

PowerShell first parses the command, then converts arguments for the native
process. Avoid one large quoted command line. Keep each logical argument as one
array element, especially paths with spaces, empty strings, wildcards, JSON,
and values beginning with `-`.

When invoking another shell is truly required, treat its command text as a new
parser boundary and document why it is needed. Do not nest shells merely to
reuse syntax from an example.
