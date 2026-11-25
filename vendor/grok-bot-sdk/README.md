# grok-bot-sdk (copied in)

These files are an unchanged copy of the MIT-licensed `grok-bot-sdk` by
RongleCat, so the shipped Grok Bot app does not download code from a
personal GitHub account at build time (VOS-1672).

- Source: https://github.com/RongleCat/grok-bot-sdk
- Commit: 42c75eb13f24630d1b689629502d4320c4219cdb (version 0.78.1)
- Files: sdk.mjs, core.mjs, avatar.mjs, errors.mjs, connect-stream.mjs,
  sse.mjs, sdk.d.mts, avatar.d.mts, LICENSE. Each one is byte-identical
  to that commit. desktop.mjs (reads the Grok Bot desktop app's Keychain
  entry, Mac only) and the CLI are left out: VoiceOS does not use them.

Do not edit these files. To update, copy the same files from a reviewed
commit and change the commit above.
