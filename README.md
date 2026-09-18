# VoiceOS Integration Template

The bare-bones starting point for every VoiceOS integration. Copy this folder,
rename it, fill in every `{{PLACEHOLDER}}`, and you have a working voice tool.

## What's in here

| File | What it is | Touch it? |
|---|---|---|
| `voiceos.integration.json` | The manifest. Identity, auth, and every tool the agent can route to. **Source of truth.** | Yes — every integration |
| `server.ts` | The MCP server. One `registerTool` per manifest tool. | Yes — every integration |
| `client.ts` | Transport. The only file that talks to Composio. Timeouts, error → spoken sentence, connect flow. | Set 3 constants at the top; add resolvers at the bottom |
| `cards.ts` | Every glance card. One accent, one header. | Yes — one card function per tool |
| `widgetKit.ts` | The shared design system. Zero deps. Identical in every integration. | **No** |
| `stdoutGuard.ts` | Reroutes `console.log` to stderr so nothing corrupts the MCP wire. | **No** |
| `run.sh` | The launcher VoiceOS calls. Installs deps on first run, prefers bun, falls back to tsx. | **No** |
| `scripts/` | The test suite: `smoke.ts` (transport, live), `read-handlers-smoke.ts` (every read tool over real MCP), `preview-cards.ts` (visual pass). Run via `bun run smoke / read-smoke / preview`. | Fill the marked spots |
| `package.json` | The four shared deps. Add more only if a tool truly needs them. | Rename only |
| `.env.example` | Copy to `.env` for standalone runs. | Copy |

## Make a new integration

**1. Copy and rename**

```sh
cp -R Template ../voiceOS-<service>-integration/<service>
cd ../voiceOS-<service>-integration/<service>
```

**2. Fill every `{{PLACEHOLDER}}`**

```sh
grep -rnE "\{\{[A-Z_]+\}\}" --exclude-dir=node_modules .
```

| Placeholder | File | Example |
|---|---|---|
| `{{ID}}` | manifest | `com.arav.github` |
| `{{NAME}}` | manifest | `GitHub` |
| `{{SUMMARY}}` | manifest, package.json | one spoken-word sentence |
| `{{DESCRIPTION}}` | manifest | 2–4 sentences |
| `{{CATEGORIES}}` | manifest | already an array — fill in one or more strings, e.g. `["Developer Tools", "Productivity"]` |
| `{{SERVICE_NAME}}` | client.ts | `GitHub` |
| `{{TOOLKIT}}` | client.ts, package.json | Composio slug, e.g. `github` |
| `{{TOOLKIT_VERSION}}` | client.ts | e.g. `20260728_00` |
| `{{LIST_TOOL_SLUG}}` / `{{CREATE_TOOL_SLUG}}` | server.ts | e.g. `GITHUB_CREATE_AN_ISSUE` (go away when you replace the example tools) |

Lowercase `{{title}}` / `{{notes}}` in the manifest are **not** placeholders —
they are confirmation-card bindings to tool arguments. Leave that syntax alone.

**3. Add the two images**

- `icon.png` — the integration's icon (the manifest points at it).
- `mark.png` — a square logo for card headers. Optional; the kit has a default.

**4. Pick an accent**

`cards.ts` → `ACCENT`. Use the service's brand colour.

**5. Replace the example tools**

The template ships one read tool (`list_items`) and one write tool
(`create_item`) to show both shapes. Replace them with real ones. For each tool:

- Declare it in the manifest (name, title, description, inputSchema).
- Register it in `server.ts` with the **same name and wording**.
- Give it a card in `cards.ts`.
- If it acts on the user's behalf, add a `confirmation` card in the manifest.
  Read-only tools must not have one.

**6. Install and run**

```sh
bun install
cp .env.example .env   # paste your Composio key
bun server.ts          # should idle cleanly; Ctrl-C to stop
```

**7. Install into VoiceOS**

Copy (or symlink) the folder into:

```
~/Library/Application Support/VoiceOS/custom-mcps/
```

then restart VoiceOS. On first use, any tool returns a "Connect" card with an
OAuth link. Approve it once.

## How auth works

Composio is the auth + API transport. You never handle OAuth tokens yourself:

1. Get an API key at https://app.composio.dev.
2. Add the service as a connected app in your Composio project. That creates
   the **auth config** `connectUrl()` looks up.
3. VoiceOS's setup field asks the user for `COMPOSIO_API_KEY` and injects it as
   an env var. `.env` is only a fallback for standalone runs.

## Rules that keep it feeling native

- **Tool descriptions are routing rules.** Say what it does AND when to use it
  ("Use when the user asks …").
- **Every result carries JSON for the model AND a card for the user.** Never
  put information only in the card.
- **Cards are a 2-second read.** Max 3 blocks. Trim strings before the kit does.
- **Be honest.** Throw on failure. Never fabricate data or claim success.
- **stdout is the wire.** Log with `console.error` only.
- **Names, not ids.** Voice users say "the vibe-dj repo". Add a resolver in
  `client.ts` that turns spoken names into ids, and treat ambiguity as an error.
