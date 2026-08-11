# Encoding and JSON

Use this reference when commands read or write text for another program, edit
JSON, or cross the Windows PowerShell 5.1 / PowerShell 7 boundary.

## Select encoding explicitly

Default encodings vary by PowerShell version and cmdlet. For UTF-8 without a
byte-order mark in both Windows PowerShell 5.1 and PowerShell 7, use .NET:

```powershell
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $text, $utf8NoBom)
```

For existing text, preserve the file's required encoding when known. Do not
rewrite an entire file merely to change one value unless formatting and
encoding changes are acceptable.

## Modify JSON as data

Parse JSON, change the object, and serialize it. Do not use regex replacement
for structural JSON edits.

```powershell
$jsonText = [System.IO.File]::ReadAllText($path)
$document = $jsonText | ConvertFrom-Json
$document.enabled = $true
$updated = $document | ConvertTo-Json -Depth 100
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText($path, $updated + [Environment]::NewLine, $utf8NoBom)
```

Choose a sufficient `ConvertTo-Json -Depth`; shallow defaults can silently
replace nested objects with abbreviated strings. After writing, parse the file
again and assert the intended value.

## Preserve arrays intentionally

PowerShell unwraps single pipeline results. Wrap results with `@(...)` when the
consumer requires an array even for zero or one item. When an API requires a
JSON array, verify the serialized top-level shape rather than assuming it.

## Console output is not file encoding

`[Console]::OutputEncoding`, `$OutputEncoding`, and a file cmdlet's `-Encoding`
control different boundaries. Change only the boundary involved in the
failure, keep the change scoped, and restore process-wide settings if they
must be modified.
