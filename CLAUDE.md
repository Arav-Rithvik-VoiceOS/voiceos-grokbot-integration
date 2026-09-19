# Grok Bot VoiceOS integration

See @AGENTS.md for how this integration works.

## After every change Arav needs to test

VoiceOS loads the MAIN folder (`/Users/arav/Vault/voiceOS-grokbot-integration`), not a worktree, and it caches the manifest. A change is not live until these steps run. Run them yourself, in this order, every time a change is ready for Arav to test. Do not only list them.

The change must be in the main folder first (merge the worktree branch into `main`; do not push unless asked).

1. Quit VoiceOS.

```bash
osascript -e 'quit app "VoiceOS"'
```

2. Push the manifest cache from the main folder. This refuses to run while VoiceOS is open.

```bash
cd /Users/arav/Vault/voiceOS-grokbot-integration && bun run push-cache
```

3. Open VoiceOS again.

```bash
open -a VoiceOS
```

Then tell Arav what to say or click to test the change. Cards that are already on screen are stale; the tool must be invoked again.
