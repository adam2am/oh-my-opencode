# Subagent Tool Access Investigation

## Problem
Subagents (explore, librarian) only get 6-7 tools instead of 60+ tools available to main agent.

**Explore agent tools:** thinking, bash, read, glob, grep, webfetch (6 tools)
**Librarian agent tools:** 60+ tools including serena, LSP, ast-grep, context7, semanthicc

## Investigation Timeline

### Iteration 1: Initial Hypothesis - `createAgentToolRestrictions`
**Hypothesis:** The `createAgentToolRestrictions()` function returns `{ permission: {...} }` on OpenCode >= 1.1.1, but OpenCode's `task.ts` only reads `agent.tools`.

**Fix Applied:** Changed `createAgentToolRestrictions()` to always return `{ tools: {...} }` format.
- File: `src/shared/permission-compat.ts`
- Updated tests in `src/shared/permission-compat.test.ts`

**Result:** ❌ FAILED - Explore still only has 6 tools

### Iteration 2: Investigated `call_omo_agent` tool
**Hypothesis:** The `call_omo_agent` tool hardcodes a minimal tools deny-list that overrides agent config.

**Finding:** `call_omo_agent/tools.ts` passes:
```typescript
tools: {
  task: false,
  call_omo_agent: false,
  sisyphus_task: false,
}
```

This is a deny-list (should allow all other tools). Same pattern as librarian which works.

**Result:** ❌ NOT THE ISSUE - Deny-list should work

### Iteration 3: Compared explore vs librarian configs
**Finding:**
| Agent | Tools Config |
|-------|--------------|
| librarian | `tools: { write: false, edit: false, background_task: false }` (direct object) |
| explore | `...restrictions` from `createAgentToolRestrictions([...])` |

Both use deny-lists. Both should work the same way.

**Result:** ❌ NOT THE ISSUE - Both use same pattern

### Iteration 4: Investigated OpenCode's tool resolution
**Finding in `prompt.ts` (lines 581-584):**
```typescript
const enabledTools = pipe(
  input.agent.tools,           // Agent's tools from registry
  mergeDeep(await ToolRegistry.enabled(input.agent)),
  mergeDeep(input.tools ?? {}),  // Tools from prompt call - LAST wins
)
```

**Finding in `ToolRegistry.tools()` (lines 117-137):**
- Only returns BUILT-IN tools (bash, read, glob, grep, edit, write, etc.)
- Does NOT include MCP tools

**Finding in `prompt.ts` (lines 649-712):**
- MCP tools are added separately via `MCP.tools()`
- Same `Wildcard.all(key, enabledTools)` filtering applies

**Result:** 🔍 NEED MORE INVESTIGATION

## Current Understanding

The tool resolution flow:
1. `ToolRegistry.tools()` returns built-in tools
2. `MCP.tools()` returns MCP tools (serena, context7, etc.)
3. Both are filtered by `enabledTools` (deny-list)
4. Deny-list should allow all tools not explicitly denied

**Mystery:** Why does librarian get MCP tools but explore doesn't?

## Next Steps
1. Check if there's a difference in how `call_omo_agent` vs `sisyphus_task` handles tool resolution
2. Check if explore agent has some hidden restriction
3. Check if MCP tools are loaded differently for different agents
4. Add debug logging to see what `enabledTools` contains for each agent

## KEY DIFFERENCE: Librarian vs Explore

### Code Comparison

**Librarian** (`src/agents/librarian.ts` line 30):
```typescript
tools: { write: false, edit: false, background_task: false }
```
- Direct object literal
- Gets 60+ tools ✅

**Explore** (`src/agents/explore.ts` lines 28-42):
```typescript
const restrictions = createAgentToolRestrictions([
  "write", "edit", "task", "sisyphus_task", "call_omo_agent",
])
return {
  ...restrictions,  // spreads { tools: {...} }
  ...
}
```
- Uses spread from helper function
- Gets only 6 tools ❌

### Both Called Same Way

Both use `call_omo_agent` tool which calls:
```typescript
await ctx.client.session.prompt({
  body: {
    agent: args.subagent_type,  // "explore" or "librarian"
    tools: { task: false, call_omo_agent: false, sisyphus_task: false },
    ...
  },
})
```

### OpenCode Tool Resolution Flow

```typescript
// packages/opencode/src/session/prompt.ts lines 581-584
const enabledTools = pipe(
  input.agent.tools,           // 1. Agent's tools from Agent.get()
  mergeDeep(await ToolRegistry.enabled(input.agent)),  // 2. Registry defaults
  mergeDeep(input.tools ?? {}),  // 3. Tools from prompt call
)
```

### Agent.get() Flow

```typescript
// packages/opencode/src/agent/agent.ts lines 239-242
item.tools = {
  ...defaultTools,  // cfg.tools from opencode.jsonc
  ...item.tools,    // Agent's own tools config
}
```

### Hypothesis

The `createAgentToolRestrictions` spread might not be merging correctly into the agent config. Need to verify:
1. What does `Agent.get("explore").tools` actually return?
2. What does `Agent.get("librarian").tools` actually return?
3. Is there a difference in how the config handler processes them?

### Config Handler Processing

Both agents get processed identically in `config-handler.ts` (lines 244-256):
```typescript
if (agentResult.explore) {
  agentResult.explore.tools = {
    ...agentResult.explore.tools,
    call_omo_agent: false,
  };
}
if (agentResult.librarian) {
  agentResult.librarian.tools = {
    ...agentResult.librarian.tools,
    call_omo_agent: false,
    "grep_app_*": true,
  };
}
```

### Next Investigation

The difference might be in how the agent configs are REGISTERED, not how they're called.
Need to add debug logging to see actual `agent.tools` values at runtime.

## Iteration 5: Logs Analysis (CRITICAL FINDING)

### Log Evidence
```
explore.tools BEFORE: {"write":false,"edit":false,"task":false,"sisyphus_task":false,"call_omo_agent":false}
librarian.tools BEFORE: {"write":false,"edit":false,"background_task":false}
```

**Both have identical deny-list patterns!** Config is correct.

### The ONLY Difference
| Agent | Model | Tools Count |
|-------|-------|-------------|
| explore | `your-backend/kiro1:claude-sonnet-4.5` | 6 tools |
| librarian | `opencode/glm-4.7-free` | 68 tools |

### Provider-Specific Filtering Found
In `ToolRegistry.tools()` (lines 122-126):
```typescript
if (t.id === "codesearch" || t.id === "websearch") {
  return providerID === "opencode" || Flag.OPENCODE_ENABLE_EXA
}
```

**codesearch and websearch are ONLY enabled for `providerID === "opencode"`!**

But that's only 2 tools. The explore agent is missing 60+ tools.

### MCP Tools Loading
In `MCP.tools()` (lines 453-456):
```typescript
if (s.status[clientName]?.status !== "connected") {
  continue
}
```

MCP tools only load if client status is "connected". MCP state is per-Instance (per-project singleton).

### Current Hypothesis
The issue might be:
1. Provider-specific tool filtering beyond codesearch/websearch
2. MCP tools not being passed to non-opencode providers
3. Something in the tool resolution that filters by provider

### Next: Check if there's more provider filtering in prompt.ts

## Iteration 6: ROOT CAUSE FOUND! 🎯

### The Problem
OpenCode has a **BUILT-IN native `explore` agent** in `packages/opencode/src/agent/agent.ts` (lines 150-165):

```typescript
explore: {
  name: "explore",
  tools: {
    todoread: false,
    todowrite: false,
    edit: false,
    write: false,
    ...defaultTools,  // <-- HARDCODED minimal tools!
  },
  native: true,  // <-- NATIVE agent takes precedence!
}
```

### Why This Happens
When `call_omo_agent` calls `session.prompt({ agent: "explore" })`:
1. OpenCode looks up agent by name
2. **Native agents take precedence** over plugin-provided agents
3. The native `explore` has hardcoded minimal tools (bash, read, glob, grep, webfetch, thinking)
4. oh-my-opencode's `explore` agent config is **IGNORED**

### Why Librarian Works
There is **NO native `librarian` agent** in OpenCode. So oh-my-opencode's librarian config is used, which gets full tool access.

### The Fix
**Rename oh-my-opencode's explore agent** to avoid collision:
- `explore` → `omo-explore` or `codebase-explorer`

### Files to Modify
1. `src/agents/explore.ts` - Change export name
2. `src/agents/index.ts` - Update export
3. `src/agents/utils.ts` - Update createBuiltinAgents
4. `src/plugin-handlers/config-handler.ts` - Update agent processing
5. `src/tools/call-omo-agent/tools.ts` - Update allowed agents list
6. Update any references in prompts/docs

## Files Modified
- `src/shared/permission-compat.ts` - Always return `{ tools: {...} }` format
- `src/shared/permission-compat.test.ts` - Updated tests
- `~/.config/opencode/oh-my-opencode.json` - Changed explore model for testing
- `~/.config/opencode/opencode.jsonc` - Added kiro1:claude-sonnet-4.5 model
