# Computer viewer threat model

## Scope and protected data

The standalone computer window is a view-only macOS `WKWebView` host. Its sensitive asset is the fresh `wss://*.cursorvm.com/websockify` URL returned by the server-side Grok Bot resolver. The URL contains bearer credentials that can expose the selected bot's desktop until they expire. The remote framebuffer is private visual data and must not be recorded or persisted by this integration.

The trusted computing base is the local VoiceOS MCP process, `client.ts`'s authenticated bot resolver, the generated integration bundle, and the embedded native helper. Spoken bot names, gateway-returned URLs, navigation attempts, popup requests, and web permission requests are untrusted.

## Security boundary

- Only `resolveAgent` selects the bot. `agentScreen` obtains the fresh URL; the tool has no URL input.
- TypeScript and Swift independently require `wss`, a `cursorvm.com` host, `/websockify`, no userinfo, no unexpected port, and one nonempty `token` plus `network_token`.
- The universal native helper is compiled during publishing, ad-hoc signed, embedded in `server.ts`, and extracted into an unpredictable `0700` session directory as a `0700` executable. It does not require Chrome, Electron, a debug port, or the Grok Bot UI.
- The credential crosses into the helper only through an anonymous stdin pipe. It is not placed in process arguments, environment variables, filenames, HTML, browser-visible URLs, history, logs, telemetry, or the MCP result.
- The generated HTML contains only the validated WebSocket origin in `connect-src`. It has a nonce-based CSP, the existing view-only noVNC bundle inline, no remote scripts, no `eval`, and no blob/data script import.
- `WKWebView` uses a nonpersistent data store and no JavaScript message bridge. The host allows only its initial `about:blank` document; external navigation, redirects, new windows, JavaScript dialogs, downloads, and media capture requests are denied.
- noVNC is constructed with `shared: true`, `viewOnly = true`, `scaleViewport = true`, and `resizeSession = false`. The bundled keyboard, gesture, keysym, and scan-code modules remain the existing inert view-only stubs. The page never invokes keyboard, pointer, clipboard, upload, screenshot, or recording paths.

## Lifecycle and cleanup

- Reopening the same bot sends a fresh validated URL to the existing helper process and replaces its document instead of stacking another window.
- Before replacement and close, the page disconnects noVNC and clears its URL reference; the host removes the document-start user script and replaces the document. Closing the window terminates its helper process.
- MCP process exit or termination kills every helper and removes its extracted session directory. Startup removes stale helper directories left by an unclean shutdown.
- Disconnects retry inside the existing credential's lifetime. After bounded retries, the page tells the user to close and reopen it; only the trusted server can obtain a fresh credential.

No token-bearing temporary HTML file exists, so file cleanup cannot expose a credential. The extracted executable contains no user or session data.

## Verification before release

- `bun test tests/computer-window.test.ts` verifies URL rejection, token-free HTML, private extraction modes, native compilation, and Swift-side rejection of an unsafe destination.
- `bun test tests/computer-window-handler.test.ts` verifies that offline desktops do not open a window and live desktops return plain JSON while launching exactly once.
- `bun run check-screen` protects the original card and its shared, view-only viewer.
- `bun run build-publish` rebuilds and embeds the universal signed helper; `bun run boot` checks the shipped server startup path.
- Live acceptance must open the card and native window together, confirm neither evicts the other, close/reopen the native window to force a fresh probe, and confirm no `voiceos-grokbot-viewer-*` directory survives after VoiceOS exits.

## Residual risk

The URL must exist briefly in the MCP process, pipe buffer, helper memory, and noVNC connection state. A process already able to inspect another same-user process's memory can recover it; this design does not claim to defend a compromised macOS account. Normal OS screenshots and external screen recording are also outside the app's control. The integration itself requests no capture permission and performs no recording or persistence.
