# Grok Bot

VoiceOS custom app: talk to Grok Bot teammates by voice. Requires the
**Grok Bot** Mac app, signed in on this account.

This repository and the VoiceOS bundled integration share the same source.
Version **1.0.25** combines upstream `a4068399ad` (2026-09-20) with the
VoiceOS 1.0.24 integration changes, originally based on `d72a87ef`.

Open a bot from the roster, then click **Open computer** in the conversation
header. The screen card's **Open** button opens the same native window.
The window supports mouse, keyboard and clipboard; the notch preview remains
read-only. Opening a window is click-only and has no voice shortcut.
Screen/chat/create voice shortcuts coexist with verified single-bot sending.
Thread reads return message text to the agent and show a card only with
`show: true`. Reply notifications avoid repeating replies visible on a screen card.

### Build and test

```sh
bun install --frozen-lockfile
bun run build-publish
bun run test
bun run boot
bun scripts/check-bundle.ts
bun run check:ui
```

Edit **server.src.ts**, not generated `server.ts`. The build regenerates assets,
SDK helpers, intents and confirmation HTML, then bundles dependencies into a
compressed module loaded in memory. The complete share payload stays below
VoiceOS's 2 MiB limit and runs with Bun or Node without adjacent source files.
Native assets require macOS 13+, Xcode Command Line Tools, and `swiftc`.
Browser checks require `agent-browser` and Chrome; they use mocked messages,
attachments and recordings. `sdk/` contains the public intent/hook helpers
needed to build independently of the VoiceOS monorepo.

The manifest is the tool-schema source of truth. `bun run freeze-confirms`
rebuilds its two message confirmation layouts without reading a personal Grok
account. Live recipient identities and histories arrive through preparation
arguments; published fallback cards contain no private roster or messages.

To sync, compare against the upstream commit above, merge **source** changes,
run the build and checks, then copy the resulting integration folder into
`voiceos-integration-sdk/examples/grokbot` (exclude `.git` and `node_modules`).
Keep source and generated assets together. In VoiceOS, **Reload** this
integration and open a new card so its cached manifest and tool grants update.
The main VoiceOS application's host/marketplace changes are maintained there.

### Conversation features

The conversation renderer preserves text, cloud image attachments, choice
requests (including multiple selection, custom answers, and dismissal), notices,
and inter-bot message attribution. Open conversations refresh while visible;
drafts and selections survive refresh. Earlier messages can be loaded on demand.
Images use Grok's authenticated attachment reader and bounded previews, rather
than putting cloud credentials or large images in the card HTML.

Authentication, forms, permissions, draft approvals, and other native-only
requests are visible as cards with an **Open in Grok Bot** action. Credentials
remain in Grok's native flow; they are never submitted through VoiceOS's logged
widget tool arguments. Video/audio playback and full-size original attachments
open Grok Bot. This does not replace every screen in Grok's
desktop app.

`conversation.ts` normalizes gateway events, `conversationService.ts` validates
actions against the live transcript and resolves images, and
`conversationWidget.ts` renders the live result card. Legacy frozen assets still
provide confirmation layouts and the desktop viewer. Live cards and message
confirmations share the native avatar renderer. Sent receipts
use the live conversation composer for follow-up messages.

Validation: `bun test voiceos-integration-sdk/examples/grokbot/conversation.test.ts`
from the repository root. After updating an installed copy, use **Reload** in
VoiceOS's integration details to load the new manifest and restart only this
integration. Version 1.0.15 adds three internal card tools; a source-only restart
without reloading the manifest cannot grant those tools to older cards.

Version 1.0.16 makes the conversation and roster fit a smaller iframe viewport.
The VoiceOS widget host also propagates the available result height through its
block wrappers and repairs legacy document scrolling, including cached cards.
Browser regression: `bun voiceos-agent-ui/scripts/check-widget-overflow.ts`.

Version 1.0.17 enables the missing widget grants and adds the native composer
menu: **Attach files** and **Teach a task**. A native multi-file picker stages
private copies behind bot-scoped opaque handles (up to 20 files, 100 MB each).
Files are uploaded in chunks only when Send is clicked, including attachment-only
messages; failures preserve the draft. Pollable jobs keep the picker and larger
uploads outside the widget bridge timeout, and send nonces prevent duplicate
submission when delivery is uncertain. Attachment sends retain reply notifications.

Teach a task prepares Grok’s computer without starting a recording. The user
explicitly starts, saves, or discards a demonstration through Grok’s recording
APIs. Saving lets Grok attach the recording and teach the bot; VoiceOS does not
send a duplicate prompt. Closing the computer keeps visible stop controls while
recording. The embedded teaching computer is interactive during recording and otherwise read-only; the separate computer window supports input at any time.
The card loads the bundled noVNC viewer on demand to stay within the HTML limit.

Additional checks: `bun test voiceos-integration-sdk/examples/grokbot/composerService.test.ts`
and `bun voiceos-integration-sdk/examples/grokbot/scripts/check-composer.ts`.
The browser check mocks uploads and recordings; it never sends a real message or
records a real computer. Reload the integration manifest, then open a fresh bot
card to receive the updated UI and tool grants.

Version 1.0.18 removes the manual reload button. The host reconnects a card whose
session was closed when the Notch hid, reusing the same grant and request ID.
Reconnection is limited to one retry after a pre-execution session rejection;
unknown outcomes, permission revocations, and approval decisions are not retried.
Stale refresh errors no longer leak into a different conversation or the roster.

Version 1.0.20 keeps messages whole instead of imposing a small per-message
quota. Conversation snapshots share a total payload budget; oversized entries
load automatically in bounded, versioned chunks as they come into view. Full
text, choices, and attachments render inline, with no “View full message” handoff.
Refreshes preserve already loaded content and drafts. The initial card is measured
after HTML/JSON escaping so very long replies still fit the Notch transport limit.
Browser regression: `bun voiceos-integration-sdk/examples/grokbot/scripts/check-full-message.ts`.


Version 1.0.21 renders message Markdown in the integration process using Marked,
Highlight.js, and KaTeX, with sanitized HTML transported through the existing
bounded chunk reader. Tables scroll horizontally within their bubble; inline code
uses Grok's red accent; fenced code preserves whitespace and language highlighting.
Headings, nested/ordered/task lists, quotations, strikethrough, reference links,
and offline MathML formulas render inline. Image extraction uses Markdown tokens
so reference images work and examples inside code are not treated as attachments.

Approval and permission cards preserve pending, approved/always-allowed, denied,
expired, cancelled, failed, and unknown states. Credential, form, secret and draft
outcomes retain their distinct labels. Completed requests have no active approval
prompt; historic connection cards do not imply that the bot needs attention.
Request summaries and locally expandable, redacted action details remain visible.
Sensitive authentication and approval actions still use Grok's native flow.

Regression coverage: `bun test voiceos-integration-sdk/examples/grokbot/rendering.test.ts`
and `bun voiceos-integration-sdk/examples/grokbot/scripts/check-rendering.ts`.
These cover the Jonah Bot expiry/table regression, all known structured request
families, safe Markdown, small Notch viewports, and live status changes without
losing the draft. Open a new bot card after reloading to use the updated renderer;
previously saved cards retain their original HTML.

Version 1.0.22 matches the Grok Bot 0.57.0 roster: native dark-mode avatar
colors (including white for “black”), deterministic ID-based defaults, all 18
shapes and native eye poses, and compact custom pictures. Groups use composite
member avatars and retain their identity and history when opened directly or
from the roster. Both the roster and open conversations refresh while visible.

Indicators follow Grok's native sidebar: green at the avatar's lower-right means
working/composing; blue at the row's right means unread messages; orange means
awaiting a response and takes precedence over unread. Idle has no marker.
The live `awaitingUserResponse` flag takes precedence over old transcript
requests, so a resolved request cannot keep a bot marked as waiting.

Verified against the installed Grok Bot 0.57.0 renderer (`sd`/`Km` avatar
selection, `Ug`/`n5` ID defaults, `mle` dark palette, `nde`/`Bx` sidebar state,
and the expanded `Lle` row), plus the live read-only gateway roster.
Regression coverage: `bun test voiceos-integration-sdk/examples/grokbot/roster.test.ts`
and `bun voiceos-integration-sdk/examples/grokbot/scripts/check-roster.ts`.
Reload the integration once to enable roster-only snapshots, then open a fresh
card; saved cards retain the HTML from when they were created.

Version 1.0.23 also uses native avatars in direct and group message confirmation
cards. These cards are frozen separately in the manifest; rebuild them after
renderer edits with `bun run freeze-confirms` in this folder. The browser check
`bun scripts/check-confirmations.ts` exercises the shipped manifest with Terry
and all 18 shapes, including shapes absent from its original sample roster,
and checks that editing/pressing Enter only stages the message for host approval.

Version 1.0.24 declares SDK fast intents for listing bots, opening one bot, and
preparing a message to one bot. Show/send publish the live individual bot names
through `INTENT_SLOT_VALUES_META_KEY` for enum slots with `valuesFrom: "tool"`.
Choices refresh at connection, every 30 seconds, on Agent trigger-down, and on
server roster reads. Duplicate/ambiguous names are excluded; an unavailable
roster or more than the SDK's 30 supported names disables name-based intents
instead of guessing or publishing only part of the roster. Listing still works.

The SDK `preToolUse` hook is scoped to this integration's own tools and prepares
the send confirmation from the cached roster without a network round trip. It
uses the SDK's agent transcript permission but does not subscribe to transcript
or dictation events. The selected enum name remains unchanged through approval;
a separate recipient ID is checked against the live roster before sending.
Single-bot sends no longer need a separate `grokbot_prepare_message` round trip;
that tool remains available for recent history and is required for groups.

From this source folder, `bun run build-intents` bundles the public SDK helpers
into the portable integration and rebuilds its manifest and confirmation HTML.
Run `bun test intents.test.ts` and `bun scripts/check-confirmations.ts` for the
enum refresh, recipient identity, MCP metadata, and confirmation regression checks.
Reload the installed integration to activate its intents and own-tool hook.
