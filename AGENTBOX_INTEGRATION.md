# AgentBox integration — RemoteCC 0.13.1

Reference: https://github.com/devilcoolyue/agentbox at
`e19df41f1383fe5ef233473a51d148f9c99d27fd`.

## Code reviewed

- `web/src/features/chat/commands.ts`: remote catalogue, command token/caret handling,
  preservation of arguments, Enter vs Tab, IME handling, cache failure backoff.
- `internal/server/slash_commands.go`, `internal/agent/claude_commands.go`:
  initialize-only catalogue probing without session persistence.
- `internal/agent/claude_control.go`: native question/permission control responses.
- `internal/chat/service.go`, `internal/agent/adapter.go`: command stays first in
  the prompt; local command output is a successful result even without a model turn.

## Integrated

- RemoteCC still discovers commands from the remote SDK, preserving aliases and
  custom project commands. No bundled replacement command catalogue.
- Completion replaces only the command token, keeping existing arguments.
- Enter executes the selected completion once through the normal composer handler;
  Tab completes; clicking model/effort opens the existing native-control picker.
- IME composition, Shift+Enter, Shift+Tab and modifier shortcuts are not consumed.
  Caret movement updates the menu; loss of focus dismisses it.
- Failed capability refresh has a ten-second retry delay while retaining the old list.
- Temporary capability inspectors use `persistSession: false` and never fork history.
- Model selector retains a custom current model and accepts a custom model ID.
  The remote `setModel` result remains authoritative before preferences are saved.
- Effort picker can use remote model effort levels even without an enumerated
  command argument hint.
- Confirmed builtin `/clear` creates a fresh RemoteCC conversation, preserving the
  old conversation and selected preferences. Project skills named `clear` remain
  remote commands. No shared remote conversation is erased.

## Boundaries

AgentBox itself intercepts model/effort/clear in its UI and has terminal fallbacks;
its command menu is not a universal renderer for every native CLI dialog.
RemoteCC continues to use its existing resident remote SDK owner, permissions and
MCP elicitation. This change does not add arbitrary `onUserDialog` kinds, terminal
fallbacks, AgentBox's Docker/account pools, or all other AgentBox features.

Attribution and Apache-2.0 license are included under `src/third-party/agentbox`,
which is shipped in the desktop package.

## Verification

- `npm test`: 49 passing tests.
- `node scripts/autocomplete-smoke.cjs`: real axi catalogue and completion UI.
- `node scripts/model-interaction-smoke.cjs`: native model/effort controls and a
  real Sonnet reply on axi.
- `scripts/agentbox-commands-smoke.cjs`: real axi suffix completion, IME,
  Shift+Tab, partial command Enter, native `/context`, and `/clear` retention.
- `npm run pack`: macOS arm64 app, version 0.13.1.
