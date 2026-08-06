---
name: open-design-mode
description: Create or refine websites, presentations, product prototypes, documents, images, video, audio, and design systems through the Open Design plugin. Use when the user selects or names Open Design for an artifact; use Open Design Cloud by default and Local Codex only when the user explicitly chooses it.
---

# Create with Open Design

Use the Open Design MCP tools as the product execution surface. Do not create a
substitute artifact yourself when the user asked Open Design to do the work.

## Keep the closure boundary invisible

The plugin lazily acquires or attaches its local runtime on the first product
tool call. Do not call `ensure_open_design_runtime` during a normal creation
workflow and do not ask the user to open Open Design Desktop. Use distribution
status tools only when the user asks for diagnostics.

Keep machine vocabulary out of user-facing prose. Do not display tool names,
raw agent selectors, `pluginWorkflowId`, `requestId`, draft ids, nonces,
tokens, runtime paths, or distribution identity. Refer only to Open Design,
Open Design Cloud, Local Codex, the project, Studio, and Preview.

## Select one execution mode

Open Design Cloud is the default mode. Use Local Codex only when the user
explicitly selects it. Preserve the selected mode through brief collection,
project selection, generation, polling, and delivery.

This closure exposes Open Design Cloud and Local Codex only. Secure BYOK is not
available through this plugin version. Never ask for or accept a raw API key,
provider token, or credential in chat or an MCP argument; explain the current
mode boundary and wait for the user to choose one of the available modes.

Never switch modes after authentication, quota, transport, or generation
failure. Explain the selected mode's failure and wait for the user to request
another mode. A mode switch starts a new logical generation.

## Start one attributed generation

For every new artifact or refinement:

1. Infer the artifact type from the request: `website`, `product-prototype`,
   `presentation`, `document`, `image`, `video`, `audio`, or `design-system`.
2. Normalize `locale` from the current request language, such as `zh-CN` for
   Simplified Chinese or `en` for English.
3. Call `collect_brief` exactly once. Do not send `externalPluginContext`; the
   verified closure shell injects its first-party identity. Include known
   answers from the user's request. Use `skip: true` only when the user has
   already supplied a complete brief or explicitly requests recommended
   defaults without questions.
4. If the interactive card renders, wait for its confirmation. If the host
   cannot render it, present the returned `questionForm` choices in plain
   language and call `confirm_brief` once with the original internal fields.
   Never ask the user to copy internal fields.
5. Preserve the server-issued workflow id returned by the tools. Pass it to
   every later login, discovery, project, run, polling, and optional artifact
   call for this logical generation.

One workflow id binds one logical run request. A refinement must reuse the same
project but start with a new `collect_brief` call and receive a new
`pluginWorkflowId`.

## Resolve the project

Prefer the active project when the user is clearly continuing it. Otherwise
list projects and resolve an unambiguous named project, or create a concise new
project. After resolution, use the explicit project id for every call so
active-context expiry cannot redirect the run.

If a refinement target is ambiguous, ask the user which existing project or
artifact they mean. Do not create a replacement project, start a run, or mutate
files until the target is unambiguous.

For refinements, reuse the same project. Never create a duplicate merely
because a new brief workflow or request id is required. Never delete projects
or files as test cleanup unless the user explicitly asks.

## Run through Open Design Cloud

For the default Cloud mode:

1. Check the Cloud sign-in state with the current workflow id. If signed out,
   start browser sign-in, show the activation action in user-facing product
   language, and wait until sign-in completes.
2. Call `list_agents` and require the machine selector `amr` to be available.
3. Generate one canonical UUID or ULID `requestId` for the confirmed action.
4. Call `start_run` once with the explicit project, confirmed brief prompt,
   workflow id, stable request id, and `agent: "amr"`.

If Cloud reports insufficient credits, preserve the project, run, workflow,
request id, and exact original arguments. Show the recharge action and wait.
After the user confirms recharge, retry with the same arguments and
`resume: true`. Never create a replacement run or infer billing success.

## Run through Local Codex

For explicitly selected Local Codex:

1. Do not call Cloud sign-in tools.
2. Call `list_agents` with the workflow id and require the machine selector
   `codex` to be installed and authenticated.
3. Append this boundary to the confirmed generation prompt:

   > This run is already the selected Local Codex execution inside Open
   > Design. Work directly in the current Open Design project. Do not invoke
   > the Open Design plugin, the open-design MCP server, Brief collection,
   > Open Design Cloud login, or another Open Design workflow. Do not route
   > this request through Open Design again.

4. Generate one canonical UUID or ULID `requestId` and call `start_run` once
   with the explicit project, workflow id, stable request id, the byte-identical
   bounded prompt, and `agent: "codex"`.

If Local Codex is missing, signed out, or out of quota, report that boundary
and offer retry after the user resolves it. Do not enter the Cloud flow unless
the user explicitly switches modes.

## Preserve exactly-once generation

Treat one confirmed action as one logical generation:

- Reuse the exact `requestId` and byte-identical `start_run` arguments only
  when a transport response is lost or the tool explicitly supports resume.
- Never reuse a request id with a changed prompt, project, mode, or agent.
- Poll only with `get_run`; polling must never call `start_run` again.
- Continue the current task while the run is queued or running. Stop only at a
  terminal state, an explicit user-input boundary, or a cancellation request.
- Call `cancel_run` only when the user asks to cancel.

## Deliver the real product result

Inspect every `start_run` and `get_run` response for the exact run id.

- When Codex Desktop exposes a callable in-app Browser and a running result
  first returns `studioUrl`, open that exact URL once so the user can follow
  live work.
- On success, require a valid deliverable and return the exact `studioUrl`,
  falling back to `previewUrl`. If no running Studio tab was opened, open the
  terminal delivery URL once when the in-app Browser is available.
- If Browser control is unavailable, provide the exact clickable link without
  treating that host limitation as generation failure.
- If success contains no Studio or Preview link, report incomplete delivery;
  do not substitute a stale or generic Open Design URL.
- For failure or cancellation, report the terminal state and do not present an
  older project link as success.

Use `get_artifact` only when source context is genuinely required for review or
follow-up reasoning. Pass the same workflow id and exact project, and treat
`truncated: true` as partial context rather than a complete project archive.
