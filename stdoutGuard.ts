/**
 * stdoutGuard.ts — reroutes every console channel to stderr.
 *
 * stdout is the MCP wire: one line of plain text on it and VoiceOS's JSON-RPC
 * client marks the whole connection broken, which silently removes this
 * integration's tools from every later turn until the app restarts. Our own
 * code already logs through `console.error`, but dependencies print through
 * whatever they like — @composio/core's version checker writes an "Upgrade
 * available!" banner via `console.info` on the first API call, which is
 * exactly how this integration disappeared from routing in production.
 *
 * MUST be the first import in `server.ts`, before any dependency's module
 * body runs. The MCP transport itself writes with `process.stdout.write`
 * directly, so rebinding the console methods cannot touch the protocol.
 */
const toStderr =
  (tag: string) =>
  (...args: unknown[]): void => {
    process.stderr.write(
      `${tag} ${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`,
    );
  };

console.log = toStderr("[stdout-guard log]");
console.info = toStderr("[stdout-guard info]");
console.warn = toStderr("[stdout-guard warn]");
console.debug = toStderr("[stdout-guard debug]");
