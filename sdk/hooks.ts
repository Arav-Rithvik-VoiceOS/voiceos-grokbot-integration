/**
 * VoiceOS Hooks — the developer's tap into the voice pipeline.
 *
 * Tools let the agent call an integration; hooks let an integration hear the
 * pipeline: the transcript before the agent sees it, its own tool calls before
 * they run, the finished turn after it lands, dictation before it is pasted.
 *
 * ## Delivery: reserved MCP tools
 *
 * A hook is an ordinary MCP tool with a reserved name (`voiceos_hook_*`) that
 * VoiceOS calls with a hard deadline. {@link defineHooks} registers them on the
 * integration's MCP server; the host hides the prefix from the agent's tool
 * list, so the model can never see or call a hook. Every hook call carries one
 * argument, `payload_json` (a JSON-encoded input object below), and returns a
 * JSON-encoded {@link HookResult} as its text content. The Minecraft rule
 * applies to both payloads: fields are added, never removed or repurposed.
 *
 * ## Fail-open, always
 *
 * A hook that times out, throws, or returns something unparsable behaves
 * exactly like no hook at all. The pipeline never waits past the event's
 * budget and never breaks on a broken handler.
 *
 * ## Consent
 *
 * Declaring any hook requires the manifest's `transcript` permission (scoped
 * to what the hooks actually read), which is surfaced loudly at install and at
 * share review. `dictation` hooks must additionally name the apps they listen
 * in (`apps` bundle-id filter) — there is no global dictation listening.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Events + manifest declaration
// ---------------------------------------------------------------------------

export type HookEvent =
  | "transcript"
  | "dictation"
  | "preToolUse"
  | "postToolUse"
  | "turnComplete";

/**
 * One hook subscription in the manifest. `apps` restricts the hook to moments
 * when one of the named macOS bundle ids is the frontmost (external) app — the
 * default posture for anything that listens broadly. Required for `dictation`.
 */
export interface HookDeclaration {
  apps?: string[];
}

/** Tool-tap hooks additionally carry a scope; v1 supports only "own". */
export interface ToolHookDeclaration extends HookDeclaration {
  /**
   * Which tool executions the hook taps. `"own"` (the default and the only
   * v1 value) means the integration's own tools; broader scopes are reserved
   * for a future, separately-permissioned grant.
   */
  scope?: "own";
}

/** The manifest's `hooks` block: which pipeline events this integration taps. */
export interface IntegrationHooks {
  /** Final agent-mode input, before the agent stream opens. */
  transcript?: HookDeclaration;
  /** Polished dictation text, just before it is pasted. `apps` is required. */
  dictation?: HookDeclaration & { apps: string[] };
  /** Before one of the integration's own tools executes. */
  preToolUse?: ToolHookDeclaration;
  /** After one of the integration's own tools executes, before the model reads the result. */
  postToolUse?: ToolHookDeclaration;
  /** Turn teardown receipt (fire-and-forget; nothing can be modified). */
  turnComplete?: HookDeclaration;
}

// ---------------------------------------------------------------------------
// Reserved tool names
// ---------------------------------------------------------------------------

/** Tools with this prefix are hook endpoints: hidden from the agent, called only by VoiceOS. */
export const HOOK_TOOL_PREFIX = "voiceos_hook_";

export const HOOK_TOOL_NAMES: Record<HookEvent, string> = {
  transcript: "voiceos_hook_transcript",
  dictation: "voiceos_hook_dictation",
  preToolUse: "voiceos_hook_pre_tool_use",
  postToolUse: "voiceos_hook_post_tool_use",
  turnComplete: "voiceos_hook_turn_complete",
};

export function isHookToolName(name: string): boolean {
  return name.startsWith(HOOK_TOOL_PREFIX);
}

// ---------------------------------------------------------------------------
// Payloads (what a handler receives)
// ---------------------------------------------------------------------------

/** The frontmost (external) app at the moment the event fired. */
export interface HookAppContext {
  bundleId?: string;
  name?: string;
}

interface HookInputBase {
  /** Payload contract version. Fields are only ever added. */
  hookApiVersion: 1;
}

export interface TranscriptHookInput extends HookInputBase {
  event: "transcript";
  /** Sanitized text, exactly what the agent would receive. */
  transcript: string;
  source: "voice" | "text";
  /** ISO 639-1, when ASR detected one. */
  detectedLanguage?: string;
  audioDurationMs?: number;
  /** Present on follow-ups within an existing agent session. */
  sessionId?: string;
  frontmostApp?: HookAppContext;
}

export interface DictationHookInput extends HookInputBase {
  event: "dictation";
  /** Post-polish text, exactly what would be pasted. */
  text: string;
  /** Pre-polish ASR output, when available. */
  rawTranscript?: string;
  detectedLanguage?: string;
  /** The app the text is about to be pasted into. */
  targetApp?: HookAppContext;
}

export interface PreToolUseHookInput extends HookInputBase {
  event: "preToolUse";
  /** The tool's manifest name (not the host-namespaced one). */
  toolName: string;
  args: Record<string, unknown>;
  frontmostApp?: HookAppContext;
}

export interface PostToolUseHookInput extends HookInputBase {
  event: "postToolUse";
  toolName: string;
  args: Record<string, unknown>;
  /** The raw result the tool returned. */
  result: unknown;
}

export interface TurnCompleteHookInput extends HookInputBase {
  event: "turnComplete";
  sessionId?: string;
  transcript: string;
  responseText: string;
  /** Tools this turn executed locally, in order. */
  tools: { tool: string; status: "done" | "failed" }[];
}

export type HookInput =
  | TranscriptHookInput
  | DictationHookInput
  | PreToolUseHookInput
  | PostToolUseHookInput
  | TurnCompleteHookInput;

// ---------------------------------------------------------------------------
// The one response envelope
// ---------------------------------------------------------------------------

/**
 * Every hook returns this shape; fields irrelevant to the event are ignored.
 * Returning `{}` — or nothing, or timing out — means "continue untouched".
 */
export interface HookResult {
  /**
   * `"continue"` (default): proceed, with any rewrites below applied.
   * `"block"`: swallow the event — the turn ends (transcript) or the tool is
   *   not executed (preToolUse) or the text is not pasted (dictation).
   * `"handled"`: the integration answered the turn itself. VoiceOS renders
   *   `responseText` (and `view`) in the notch and the agent never runs.
   *   Meaningful for `transcript` and `dictation` (where it means "consumed").
   */
  decision?: "continue" | "block" | "handled";
  /** transcript / dictation: replaces the text that flows on. */
  updatedText?: string;
  /** preToolUse: replaces the tool's arguments. */
  updatedArgs?: Record<string, unknown>;
  /** postToolUse: replaces the result the model will read. */
  updatedResult?: unknown;
  /** transcript: extra context appended to the turn for the model. */
  additionalContext?: string;
  /**
   * preToolUse: escalate this call to a user confirmation card. One-way only —
   * a hook can add a confirmation, never remove or approve one; the user's
   * per-tool lock pills always win.
   */
  requireConfirmation?: true;
  /** Shown in the notch when the decision is "handled" (or "block"). */
  responseText?: string;
  /**
   * Notch card shown for a "handled" turn — the same glance-block contract as
   * tool result cards (`{ blocks: [...] }`, widget block allowed).
   */
  view?: { blocks: unknown[] };
  /** Logged to the integration's log ring; never shown to the model. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// defineHooks — server-side registration helper
// ---------------------------------------------------------------------------

export interface HookHandlers {
  transcript?: (
    input: TranscriptHookInput,
  ) => HookResult | Promise<HookResult | void> | void;
  dictation?: (
    input: DictationHookInput,
  ) => HookResult | Promise<HookResult | void> | void;
  preToolUse?: (
    input: PreToolUseHookInput,
  ) => HookResult | Promise<HookResult | void> | void;
  postToolUse?: (
    input: PostToolUseHookInput,
  ) => HookResult | Promise<HookResult | void> | void;
  turnComplete?: (
    input: TurnCompleteHookInput,
  ) => HookResult | Promise<HookResult | void> | void;
}

/**
 * The slice of an MCP server `defineHooks` needs — structurally compatible
 * with `McpServer.tool(name, description, paramsSchema, cb)` from
 * `@modelcontextprotocol/sdk` without depending on it.
 */
export interface HookToolRegistrar {
  tool(
    name: string,
    description: string,
    paramsSchema: Record<string, unknown>,
    cb: (args: {
      payload_json: string;
    }) => Promise<{ content: { type: "text"; text: string }[] }>,
  ): unknown;
}

/**
 * Register the reserved hook tools for the handlers you implement:
 *
 * ```ts
 * defineHooks(server, {
 *   async transcript({ transcript }) {
 *     if (!isOrderIntent(transcript)) return {};
 *     const order = await createDraftOrder(transcript);
 *     return { decision: "handled", responseText: "Draft order created" };
 *   },
 * });
 * ```
 *
 * Handlers may return a {@link HookResult} or nothing (= continue). A thrown
 * error is reported as an MCP tool error; the host treats it as "continue".
 *
 * The single `payload_json` argument is declared as a zod raw shape
 * (`{ payload_json: z.string() }`), matching what the official
 * `@modelcontextprotocol/sdk` `McpServer.tool` overloads expect.
 */
export function defineHooks(
  server: HookToolRegistrar,
  handlers: HookHandlers,
): void {
  for (const event of Object.keys(HOOK_TOOL_NAMES) as HookEvent[]) {
    const handler = handlers[event];
    if (!handler) continue;
    server.tool(
      HOOK_TOOL_NAMES[event],
      `VoiceOS ${event} hook endpoint (reserved — called by VoiceOS, hidden from the agent).`,
      { payload_json: z.string() },
      async ({ payload_json }) => {
        let input: HookInput;
        try {
          input = JSON.parse(payload_json) as HookInput;
        } catch {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({}) }],
          };
        }
        const result =
          ((await handler(input as never)) as HookResult | undefined) ?? {};
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result) }],
        };
      },
    );
  }
}
