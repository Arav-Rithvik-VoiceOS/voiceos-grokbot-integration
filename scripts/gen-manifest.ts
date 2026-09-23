/** Regenerate intents and confirmation HTML from the checked-in manifest.
 * Uses public fixtures only; never reads a personal Grok roster or transcript. */
await import("./build-intents.ts");
await import("./freeze-confirms.ts");
