# Native commands

Use this reference for `.exe` files and cross-platform CLIs such as `git`,
`node`, `pnpm`, `docker`, or `curl.exe`.

## Resolve and invoke

Probe uncertain commands before use:

```powershell
$command = Get-Command git -ErrorAction Stop
$args = @('-C', $repoPath, 'status', '--short')
& $command.Source @args
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) { throw "git failed with exit code $exitCode" }
```

Use `&` when the executable is stored in a variable or its path is quoted.
Build dynamic arguments as an array. Do not flatten the array into a string.

## Treat exit status as authoritative

`$?` describes the success of the most recent PowerShell operation and can be
overwritten by another expression. Capture `$LASTEXITCODE` immediately after a
native process. Stdout does not prove success, and stderr does not necessarily
prove failure.

When output is needed, capture it without losing the exit code:

```powershell
$output = & $exe @args 2>&1
$exitCode = $LASTEXITCODE
if ($exitCode -ne 0) {
    throw "Command failed ($exitCode): $($output -join [Environment]::NewLine)"
}
```

Only merge stderr into stdout when combined diagnostic text is acceptable. If
the streams have different meanings, redirect them to separate files or keep
the tool's structured result.

## Avoid pipeline shape surprises

PowerShell pipelines pass objects between cmdlets, but native programs receive
text. A cmdlet can emit zero, one, or many objects; normalize intentionally
with `@(...)` when later code requires an array.

Avoid formatting cmdlets such as `Format-Table` before filtering, exporting,
or serializing. Formatting output is for display, not data processing.

## Prefer explicit tools

PowerShell aliases can differ by version and profile. In scripts, prefer full
cmdlet names. On Windows PowerShell, `curl` may resolve to a PowerShell alias;
use `curl.exe` when the native executable is specifically required.
