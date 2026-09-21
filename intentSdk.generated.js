// Generated from the VoiceOS SDK by scripts/build-intent-sdk.ts.
// @bun
// sdk/intents.ts
var INTENT_SLOT_VALUES_META_KEY = "voiceos/intent-slot-values";
var INTENT_REFRESH_NOTIFICATION_METHOD = "notifications/voiceos/refresh_intent_values";
// sdk/hooks.ts
import { z } from "zod";
var HOOK_TOOL_NAMES = {
  transcript: "voiceos_hook_transcript",
  dictation: "voiceos_hook_dictation",
  preToolUse: "voiceos_hook_pre_tool_use",
  postToolUse: "voiceos_hook_post_tool_use",
  turnComplete: "voiceos_hook_turn_complete"
};
function defineHooks(server, handlers) {
  for (const event of Object.keys(HOOK_TOOL_NAMES)) {
    const handler = handlers[event];
    if (!handler)
      continue;
    server.tool(HOOK_TOOL_NAMES[event], `VoiceOS ${event} hook endpoint (reserved \u2014 called by VoiceOS, hidden from the agent).`, { payload_json: z.string() }, async ({ payload_json }) => {
      let input;
      try {
        input = JSON.parse(payload_json);
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify({}) }]
        };
      }
      const result = await handler(input) ?? {};
      return {
        content: [{ type: "text", text: JSON.stringify(result) }]
      };
    });
  }
}
export {
  defineHooks,
  INTENT_SLOT_VALUES_META_KEY,
  INTENT_REFRESH_NOTIFICATION_METHOD
};
