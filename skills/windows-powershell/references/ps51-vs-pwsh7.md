# Windows PowerShell 5.1 and PowerShell 7

Use this reference before relying on syntax or cmdlets that differ across the
two runtimes.

## Detect, do not guess

```powershell
$major = $PSVersionTable.PSVersion.Major
$edition = $PSVersionTable.PSEdition
$isPowerShell7 = $major -ge 7
```

Windows PowerShell 5.1 normally reports `Desktop`; PowerShell 7 reports `Core`.
The host OS alone does not identify the runtime. `$IsWindows` is not available
in Windows PowerShell 5.1, so do not use it in shared scripts without a guard.

## Compatibility choices

| Need | Shared 5.1/7 form | PowerShell 7-only convenience |
| --- | --- | --- |
| Run step B after A succeeds | Run A, test success/exit code, then run B | `A && B` |
| Run fallback after failure | Use `try/catch` or explicit status branch | `A || B` |
| Choose a value | Use `if (...) { ... } else { ... }` | Ternary `? :` |
| Null fallback | Test `$null -eq $value` explicitly | `??` |
| Parallel pipeline | Use an explicit job/runspace only when justified | `ForEach-Object -Parallel` |
| Web request parsing | Inspect returned object and status explicitly | Newer cmdlet defaults/options |

Do not use `&&`, `||`, `? :`, `??`, or other newer syntax until PowerShell 7
has been confirmed. Parser failure occurs before a runtime guard can protect
PowerShell 5.1 from unsupported syntax in the same file.

## Starting a child process

Prefer the current shell for simple commands. When a clean process boundary is
needed, resolve the executable first:

```powershell
$pwsh = Get-Command pwsh -ErrorAction SilentlyContinue
$engine = if ($pwsh) { $pwsh.Source } else { 'powershell.exe' }
& $engine -NoProfile -File $scriptPath
$exitCode = $LASTEXITCODE
```

Do not silently switch engines if the task requires a specific version.
Report the missing runtime instead.

## Encoding warning

Windows PowerShell 5.1 and PowerShell 7 use different default encodings for
several file cmdlets. Never rely on those defaults for files consumed by other
tools. Read `references/encoding-and-json.md` and select an encoding explicitly.
