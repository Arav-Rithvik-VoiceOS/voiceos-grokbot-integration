const result = await Bun.build({
  entrypoints: [new URL("./intent-sdk.entry.ts", import.meta.url).pathname],
  target: "bun", format: "esm", external: ["zod"],
});
if (!result.success) throw new Error(String(result.logs));
await Bun.write(new URL("../intentSdk.generated.js", import.meta.url),
  "// Generated from the VoiceOS SDK by scripts/build-intent-sdk.ts.\n" + await result.outputs[0].text());
