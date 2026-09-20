# Spec: Enlarged screen in a webview window (phase 1, view-only)

## Objective

Show a Grok Bot teammate's live computer **bigger** — take the exact view-only
feed we already render in the notch screen card and display it in its own
**chromeless webview window**. Same picture, larger surface. Nothing more.

## Scope

**In scope:** a chromeless webview window that streams a bot's desktop **view-only**
(watch, don't touch), reusing the existing noVNC viewer as-is, just enlarged.

**Out of scope (phase 2 — takeover, do NOT build here):** any interactivity /
control, `viewOnly=false`, a full (un-stubbed) noVNC input bundle, keyboard/mouse
forwarding, auto-starting a bot's computer. This spec must not add those.

## Security requirements (non-negotiable)

The desktop websocket URL contains a live token. Treat it as a bearer
credential: anyone who obtains the URL may be able to view that bot's desktop
until the session expires. The fact that the websocket does not require a
cookie does **not** make the URL safe to expose.

### Token and URL handling

- Prefer injecting the websocket URL through private, in-memory application
  state or secure host-to-viewer IPC. Do not put it in a browser address bar,
  query string, page title, visible UI, tool result, telemetry, or log output.
- If a temporary HTML file is required, create it in the session temp
  directory with a unique unpredictable filename and restrictive `0600`
  permissions. Never commit a file containing a real token. Remove it on
  normal close, failure, and process exit, and clean up stale files at startup.
- Do not put the token in filenames, crash messages, analytics, or diagnostic
  output. Errors shown to the user must be generic and must redact URLs and
  tokens.
- The server, not the viewer, resolves the bot and obtains the fresh URL. The
  viewer must never accept an arbitrary user-supplied websocket URL or fetch
  credentials itself.
- Before opening a connection, validate that the URL uses `wss:`, has the
  expected `cursorvm.com` host and `/websockify` path, has no userinfo or
  unexpected port, and contains the expected token parameters. Reject `ws:`,
  `http:`, localhost/private-network hosts, and unexpected destinations.

### Webview host hardening

The chosen host must be a restricted viewer, not a general-purpose browser
surface:

- **Electron:** disable Node integration; enable context isolation and the
  renderer sandbox; expose only a minimal, read-only preload API if one is
  needed; do not expose filesystem, shell, or arbitrary IPC capabilities.
- **WKWebView:** do not add a JavaScript bridge unless required; if one is
  added, expose only narrowly scoped, non-credential operations and validate
  every message.
- Restrict navigation to the local viewer document and the approved websocket
  destination. Block arbitrary external navigation, redirects, downloads, and
  popup windows by default. Do not allow the remote desktop to turn the window
  into a general web browser.
- Request no unnecessary permissions: no microphone, camera, screen capture,
  clipboard access, downloads, or input/control capability in phase 1.
- Apply a strict Content Security Policy. Load only bundled viewer code and
  connect only to the validated `wss://` desktop endpoint; do not load remote
  scripts or use dynamic code execution (`eval`/equivalents).

### Privacy and lifecycle

- Display the target bot identity, connection state, and a clear **VIEW ONLY**
  indicator so the user understands what is on screen and that no control is
  being sent.
- The viewer must not initiate recording, screenshots, uploads, or persistence
  of remote desktop content. Disable downloads and avoid local storage for the
  viewer; normal OS-level screenshots remain outside the app's control.
- On expiry or disconnect, show a clear disconnected state and reconnect only
  through trusted local code that obtains a fresh URL. Never ask the renderer
  to mint or refresh credentials.
- When the window closes or the viewer is replaced, clear the URL from active
  renderer state where practical and remove its temporary file. Multiple
  viewers may share the websocket only after confirming that `shared:true`
  does not evict or expose one viewer to another.

### Host decision and shipping boundary

- Chrome app mode is acceptable for a fast local proof of concept only. It is
  not a sufficient security boundary for a production release because the
  user's Chrome profile, extensions, history, crash reporting, and browser
  permissions are outside this integration's control. If used for the proof,
  require Chrome explicitly, never silently fall back to a default browser,
  and return a helpful error when Chrome is unavailable.
- A production host must be a hardened native `WKWebView` helper or a hardened
  Electron window that satisfies the rules above. Choose and threat-model that
  host before shipping to users.

## Background — what already exists (reuse, do not rebuild)

Confirmed by reading the repo and by live testing this session:

- **Auth model (proven).** The desktop websocket
  `wss://<pod>.cursorvm.com/websockify?token=<N>&network_token=<tok>` authenticates
  by the **token in the URL alone** (a raw Node connection with no cookies received
  the `RFB 003.008` VNC handshake). The pod's own `vnc.html` assets 404 without the
  token, which is why we host our own viewer. **No cookie needed.** The URL is
  nevertheless a bearer credential and must follow the security rules above;
  “no cookie needed” is an implementation fact, not permission to expose it.
- `server.src.ts` -> **`view_bot_desktop_live`**: READ tool that probes liveness and
  already yields `{ wsUrl, viewerUrl, live }` for a bot. **This is our URL source —
  no Grok Bot app, CDP, or debug port needed.**
- `client.ts` -> `vncViewerUrl()`, `vncWsUrl(viewerUrl)`, `agentScreen(...)`,
  `resolveAgent(spoken)`, `openBotComputer(agentId)` (local-exec launch helper).
- `cards.ts` -> `screenCard(bot, { wsUrl, viewerUrl })`; injects the viewer bundle
  (`RFB_B64`) only when a live stream exists.
- `widgets/screen.html` -> the viewer: `new RFB(box, url, { shared:true })`,
  `viewOnly=true`, `scaleViewport=false`. ~260 lines. **Reused as-is (view-only).**
- `scripts/build-rfb.ts` -> `widgets/rfb.b64`, the **view-only** noVNC bundle
  (keyboard/gesture/keysym stubbed, ~60k). **Reused as-is — no new build step.**

The only real difference from the card is the surface it renders on: a bigger
window instead of the 96k-capped notch glance.

## Approach

Solution A (host our own noVNC, borrow only the websocket) — already how the card
works. Phase 1 = point the **same view-only viewer** at the same `wsUrl` inside a
larger chromeless window.

Flow: resolve bot -> get live `wsUrl` (reuse `view_bot_desktop_live` probe) -> inject
the URL through private in-memory host state when supported, or a `0600` session
temp file when necessary -> open the self-contained view-only viewer in a
chromeless webview window, scaled up to fill.

## Requirements

### Viewer page

- **R-010** New `widgets/computer.html`: a full-window viewer that **reuses
  `screen.html`'s connect logic** (`new RFB(box, wsUrl, { shared:true })`, reconnect)
  and the **existing view-only `widgets/rfb.b64`** bundle. `viewOnly` stays **true**.
- **R-011** Inject the target `wsUrl` through private in-memory host state or a
  `0600` session temp file, not a hardcoded pod. Do not put the live URL in a
  query string, address bar, visible UI, tool result, or log output.
- **R-012** Fill the window and **scale up** so a small remote desktop enlarges to
  the window size (`scaleViewport=true`, or equivalent CSS scale of the canvas).
  Resize follows the window. Keep aspect sane; edges may letterbox rather than
  distort.
- **R-013** Connection states visible: connecting, connected, disconnected/error,
  auto-reconnect on drop. On fatal failure show a short message, not a blank screen.
- **R-014** Self-contained (bundle inlined) so it can open from a local document
  with no local web server and no fetch of viewer assets. A local `file://`
  document is permitted only for the restricted viewer and must not load remote
  scripts or become a general browser surface.
- **R-015** No input is forwarded to the remote (view-only). Do not wire keyboard or
  pointer send paths.

### Server tool + launch

- **R-020** New tool **`grokbot_open_computer_window`** (manifest + `server.ts`
  registration, names matching): input = bot identifier ("as the user said it"),
  resolved via `resolveAgent`. Description carries a "Use when the user asks to see a
  bot's screen bigger / in a window" routing line.
- **R-021** Handler reuses the **`view_bot_desktop_live` probe** for `{ wsUrl, live }`.
  It must **not** depend on the Grok Bot app running, on `--remote-debugging-port`,
  or on reading the app's DOM.
- **R-022** On live: write the self-contained view-only `computer.html` (existing
  bundle + injected `wsUrl`) to the session temp dir and open the webview window
  (R-030). Return plain JSON (short confirmation). If the result would carry a
  `_voiceos_glance`, ensure it does not suppress any following confirmation
  (pre-step rule).
- **R-023** On **not live**: do not open a blank window. Return a clear result
  ("<bot>'s computer is not running right now").
- **R-024** Read-like, local, reversible -> declares **no confirmation card**
  (consistent with `view_bot_desktop_live`).

### Windowing

- **R-030** Open the viewer in a **chromeless webview window** (no tabs, address bar,
  or back button), launched from a local-exec helper in the style of
  `openBotComputer`. Host mechanism = Decision D1, and the selected host must
  satisfy the security requirements above.
- **R-031** If the chosen host is unavailable, return a helpful message; never fail
  silently.
- **R-032** Re-invoking for the same bot reuses/refreshes rather than stacking
  duplicate windows where feasible.

### Manifest / permissions / hygiene

- **R-040** Manifest tool matches `server.ts` exactly (name, "Use when..."
  description, inputSchema); `gen-manifest` / `check-screen-card` style checks pass.
- **R-041** Confirm the existing `cursorvm.com` network permission covers the
  per-bot pod host; add nothing broader.
- **R-042** Temp `computer.html` carries a live token -> prefer private in-memory
  injection; if a file is unavoidable, write it to the session temp dir with
  `0600` permissions and a unique unpredictable name, clean up stale files and
  remove it on close/failure/exit. Never commit or log a file or URL containing
  a real token.

### Security acceptance

- **R-050** Only the server-side bot resolver may select the target and obtain a
  fresh websocket URL. The viewer accepts no arbitrary URL, credentials, or
  navigation target from user input.
- **R-051** All connection targets are validated as `wss://` endpoints on the
  expected `cursorvm.com` host, with the expected path and parameters. Invalid,
  private-network, non-TLS, or unexpected-host targets fail closed.
- **R-052** The host enforces no Node integration, context isolation, and
  sandboxing where supported; navigation, redirects, popups, downloads, and
  permissions are denied by default and explicitly allowlisted only when
  needed.
- **R-053** The viewer has a strict CSP, loads only bundled code, uses no
  dynamic code execution, and exposes no filesystem, shell, credential, or
  unrestricted IPC capability to page content.
- **R-054** No token or remote desktop content appears in logs, URLs visible to
  users, browser history, telemetry, crash reports, screenshots, recordings,
  downloads, or persistent viewer storage.
- **R-055** The implementation documents the chosen host's threat model and
  verifies cleanup and credential refresh on close, failure, disconnect, and
  process exit before release.

## Edge cases

- **E-1** Token/session expires while open -> viewer shows disconnected + retries;
  if dead, message the user to reopen (a fresh probe mints a new URL).
- **E-2** Bot has no desktop / never started -> R-023 path.
- **E-3** Multiple viewers (card + window) share via `shared:true` — confirm they
  don't evict each other.
- **E-4** Bot name ambiguous/unresolved -> `resolveAgent` error surfaced plainly.
- **E-5** Small or High-DPI remote -> R-012 scaling keeps it legible.
- **E-6** Invalid or unexpectedly shaped websocket URL -> fail closed with a
  generic error and redact the URL/token from logs and user-visible output.
- **E-7** Chrome is unavailable, has an incompatible policy, or cannot provide
  the required restricted behavior -> return a helpful error; do not silently
  open the default browser or a less-restricted host.

## Open decision

- **D1 — Webview host.** (a) Native **WKWebView** helper (tiny Swift window) — a true
  webview, no external app dependency, and the preferred production boundary,
  but a new binary to build/ship. (b) **Chrome app mode**
  (`open -a "Google Chrome" --args --app="file://…"`) — a chromeless
  webview-style window with zero new binary, but requires the user to have Chrome
  and is only acceptable for a local proof of concept. Pick one before build;
  Chrome app mode must not be presented as production-secure without a separate
  threat-model review. A hardened Electron shell is another production-capable
  option only if it satisfies the Electron rules above.

## Definition of done

- Saying "open Pepper's computer in a window" (and the equivalent tool call) opens a
  **chromeless window** showing Pepper's live desktop **enlarged, view-only**.
- When the bot's computer is not running, the user gets a clear message, not a blank
  window.
- Reuses the existing view-only `widgets/rfb.b64` and `screen.html` connect logic —
  **no interactivity, no new input bundle** (that is phase 2).
- No dependency on the Grok Bot app, a debug port, or any cookie.
- Manifest tools and `server.ts` registrations match; existing screen-card behavior
  and checks still pass.
- No temp file containing a live token is committed.
- The selected host passes the security acceptance requirements: no arbitrary
  navigation or popup surface, no unnecessary permissions, strict CSP, validated
  `wss://` target, redacted diagnostics, and verified token/file cleanup.
