import { avatarCss, buildAvatarRuntime } from "./avatar.ts";
import { CONFIRMATION_ADAPTER } from "./assets.generated.ts";

// The renderer uses IDs internally, while fast-intent argument validation must
// retain the selected enum name through approval. Do not stage an ID over it.
export const confirmationAdapter = `let confirmationBotRef;\n${CONFIRMATION_ADAPTER}`
  .replace("stage = function(key, value) {", "stage = function(key, value) {\n  if (key === 'bot' && typeof confirmationBotRef === 'string') value = confirmationBotRef;")
  .replace("confirmationBooted = true;", "confirmationBooted = true;\n  if (DEMO.data.tool === 'grokbot_send') confirmationBotRef = event.data.args?.bot;");

/** Keep the confirmation's input/approval bridge while sharing native avatars.
 * The old clip-path CSS was pruned against a frozen sample roster, so live bots
 * whose shapes were absent from that sample (including Terry) became squares.
 */
export function withConfirmationAvatars(html: string): string {
  const declaration = /^const av=.*;$/m;
  if (!declaration.test(html))
    throw new Error("Confirmation template is missing its avatar renderer");
  return html
    .replace(
      declaration,
      () => `${buildAvatarRuntime("D.bots || []")}
const av=(b,cls='')=>avatar(b,cls!=='tiny'&&Boolean(b.working)).replace('<span class="avatar','<span class="av native-avatar '+esc(cls)+' avatar');`,
    )
    .replace(
      "</style>",
      () => `${avatarCss}
.av.native-avatar{display:inline-flex;background:transparent;clip-path:none;animation:none}
</style>`,
    );
}
