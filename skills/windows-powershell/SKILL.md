---
name: windows-powershell
en_name: "Windows PowerShell"
zh_name: "Windows PowerShell 可靠执行"
description: |
  Execute, diagnose, and verify commands reliably in Windows PowerShell 5.1 or PowerShell 7. Use for Windows shell commands, .ps1 scripts, native CLI invocation, Bash-to-PowerShell translation, quoting or path failures, JSON and encoding work, and PowerShell failure recovery.
en_description: "Execute, diagnose, and verify Windows PowerShell commands with version-aware syntax, safe argument passing, and explicit completion checks."
zh_description: "通过版本感知语法、安全参数传递和明确的完成验证，可靠执行与诊断 Windows PowerShell 命令。"
triggers:
  - "Windows PowerShell"
  - "powershell command"
  - "pwsh"
  - "Windows shell"
  - ".ps1"
  - "Bash to PowerShell"
  - "PowerShell quoting"
  - "PowerShell failed"
  - "PowerShell 命令"
  - "PowerShell 执行失败"
od:
  mode: utility
  category: developer-tools
  design_system:
    requires: false
  example_prompt: "Use Windows PowerShell to run this command, diagnose any failure, and verify the final state."
  example_prompt_i18n:
    zh-CN: "使用 Windows PowerShell 执行这项操作，诊断任何失败，并验证最终状态。"
---

# Windows PowerShell

Execute PowerShell commands through a short inspect-run-verify loop. Prefer
predictable commands over compressed one-liners.

## Execution contract

1. Identify the actual shell and runtime before relying on version-sensitive
   behavior. Inspect `$PSVersionTable.PSVersion` and
   `$PSVersionTable.PSEdition`; do not infer PowerShell 7 from a Windows host.
2. Confirm the working directory with `Get-Location` when it affects the
   result. Use the shell tool's working-directory option when available.
3. Translate Unix command semantics into PowerShell. Do not paste Bash
   heredocs, `export`, `source`, `VAR=value command`, backslash continuations,
   or Bash-style command substitutions.
4. Use `-LiteralPath` for discovered or user-supplied paths and `Join-Path`
   when constructing paths. Invoke quoted executable paths with `&`.
5. Pass dynamic native arguments as an array and splat the array. Never build
   a command string for `Invoke-Expression`.
6. Use `-ErrorAction Stop` or a narrowly scoped
   `$ErrorActionPreference = 'Stop'` with `try/catch` for cmdlet failures that
   must stop the step. Check `$LASTEXITCODE` after native commands.
7. Keep simple operations inline. For complex multiline logic, write a `.ps1`
   file, check it with `scripts/Test-PowerShellSyntax.ps1`, then run it with a
   new PowerShell process using `-NoProfile -File`. Do not nest
   `powershell -Command` calls without a concrete boundary reason.
8. When a command fails, classify it before retrying: parser/quoting,
   parameter binding, missing command/path, version/profile, permission or
   sandbox, network/authentication, or native application exit. Fix the
   classified cause instead of adding random escaping.
9. Resolve and inspect targets before deletion, overwrite, move, install,
   execution-policy, or permission changes. Do not bypass the host tool's
   sandbox or approval boundary.
10. After a mutation reports success, use a separate read-only command to
    verify the intended state before reporting completion.

## Progressive references

Read only the references needed for the current failure or command:

- For interpolation, metacharacters, here-strings, or nested quoting, read
  `references/quoting-and-parsing.md`.
- For executables, argument arrays, pipelines, stdout/stderr, or exit codes,
  read `references/native-commands.md`.
- For Windows PowerShell 5.1 versus PowerShell 7 behavior, read
  `references/ps51-vs-pwsh7.md`.
- For text encoding, JSON, or structured file edits, read
  `references/encoding-and-json.md`.
- After any failure or ambiguous partial success, read
  `references/failure-recovery.md`.

Resolve these paths from the skill root advertised above the skill body. Do
not edit the staged skill copy as part of the user's task.

## Command patterns

Use an argument array for a native executable:

```powershell
$gitArgs = @('status', '--short', '--', $targetPath)
& git @gitArgs
if ($LASTEXITCODE -ne 0) { throw "git exited with code $LASTEXITCODE" }
```

Use terminating cmdlet errors for a failure-sensitive step:

```powershell
try {
    Copy-Item -LiteralPath $source -Destination $destination -ErrorAction Stop
} catch {
    throw "Copy failed: $($_.Exception.Message)"
}
```

Check a generated script without executing it:

```powershell
& powershell.exe -NoProfile -File '<skill-root>\scripts\Test-PowerShellSyntax.ps1' -Path '.\task.ps1'
if ($LASTEXITCODE -ne 0) { throw 'PowerShell syntax check failed' }
```

Use `pwsh` instead of `powershell.exe` only after confirming it is available
with `Get-Command pwsh -ErrorAction SilentlyContinue`.

## Completion report

Report the runtime used, the operation result, and the independent verification
result. If verification is impossible, name the missing evidence and do not
describe the task as completed.
