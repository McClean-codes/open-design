# Failure recovery

Use this reference after a failed command, a partial mutation, or an ambiguous
result.

## Capture evidence before changing the command

Record:

- the PowerShell version and edition;
- the working directory;
- the resolved command from `Get-Command`;
- the exact parameter or argument array shape without secrets;
- the PowerShell exception category and message;
- `$LASTEXITCODE` for native programs;
- the target state observed with `Test-Path -LiteralPath`, `Get-Item`, or a
  domain-specific read-only check.

Never print credentials, tokens, or full sensitive environment values while
collecting evidence.

## Classify one primary failure

| Class | Typical evidence | Next action |
| --- | --- | --- |
| Parser or quoting | Parser error, unexpected token, unterminated string | Reduce quoting surface; run the Parser checker |
| Parameter binding | Unknown/ambiguous parameter, wrong type | Inspect `Get-Command ... -Syntax` and object types |
| Command or path resolution | Command not found, item absent | Use `Get-Command` or `Test-Path -LiteralPath` |
| Runtime or profile | Works in one shell/profile only | Compare version/edition; retry with an explicit `-NoProfile` boundary |
| Permission or sandbox | Access denied, blocked tool policy | Stop and request the required authority; do not bypass controls |
| Network or authentication | HTTP/auth/TLS/proxy failure | Verify endpoint and credential presence without exposing secrets |
| Native application exit | Nonzero `$LASTEXITCODE` | Interpret that program's exit contract and diagnostics |
| Partial mutation | Some targets changed before failure | Inspect state, then choose a safe resume or rollback |

## Retry rule

Retry only after changing something tied to the classified cause. Do not keep
adding quotes, backticks, `-Force`, administrator elevation, execution-policy
changes, or alternate shells to see what happens.

Before retrying a mutation, determine whether the first attempt already made a
partial change. Prefer idempotent commands or an explicit resume point.

## Completion rule

Treat process success and task success separately. A zero exit code proves only
the process contract. Run an independent, read-only check of the requested
state. If the check cannot be performed, report the result as unverified.
