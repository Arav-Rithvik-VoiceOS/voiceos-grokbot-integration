import { test, expect, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm, mkdir, readdir, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ComposerFiles,
  sweepStaleAttachments,
  teachTask,
  type ComposerTransport,
  type teachTransport,
} from "./composerService.ts";
import {
  LIVE_CHAT_JS,
  COMPOSER_KIT_JS,
  MESSAGING_ADAPTER,
  SHOW_ADAPTER,
} from "./assets.generated.ts";
import manifest from "./voiceos.integration.json";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0)) await clean();
});
async function fixture(overrides: Partial<ComposerTransport> = {}) {
  const dir = await mkdtemp(join(tmpdir(), "grok-composer-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "reference image.png"),
    bytes = Buffer.alloc(600000, 123);
  await writeFile(path, bytes);
  const uploads: any[] = [],
    sends: any[] = [];
  const transport: ComposerTransport = {
    listAgents: async () => [
      { id: "a", name: "Picasso" },
      { id: "b", name: "Bot B" },
    ],
    pickLocalFiles: async () => [path],
    uploadAttachmentChunk: async (args) => {
      uploads.push(args);
      return args.offset + Buffer.from(args.bytesBase64, "base64").length ===
        args.totalSize
        ? { committedPath: "/home/box/attachments/reference.png" }
        : {};
    },
    sendPrompt: async (...args) => {
      sends.push(args);
      return { accepted: true };
    },
    ...overrides,
  };
  const service = new ComposerFiles(transport);
  cleanups.unshift(() => service.dispose());
  async function pick() {
    const body = await service.handle({ bot: "a", action: "pick" });
    await service.settled(body.job!.id);
    return await service.handle({
      bot: "a",
      action: "status",
      jobId: body.job!.id,
    });
  }
  return { service, pick, uploads, sends, path, bytes };
}
test("picker stages private opaque handles and uploads actual bytes only on send", async () => {
  const f = await fixture();
  const chosen = await f.pick();
  expect(f.uploads).toHaveLength(0);
  expect(chosen.attachments).toHaveLength(1);
  expect(JSON.stringify(chosen)).not.toContain(f.path);
  expect(chosen.attachments[0].name).toBe("reference image.png");
  const sent = await f.service.handle({
    bot: "a",
    action: "send",
    attachments: chosen.attachments.map((f) => f.id),
    message: "",
    clientNonce: "attachment-only-1",
  });
  await f.service.settled(sent.job!.id);
  expect(f.uploads.map((u) => u.offset)).toEqual([0, 262144, 524288]);
  expect(
    Buffer.concat(f.uploads.map((u) => Buffer.from(u.bytesBase64, "base64"))),
  ).toEqual(f.bytes);
  expect(f.sends).toEqual([
    [
      "a",
      "",
      {
        attachmentPaths: ["/home/box/attachments/reference.png"],
        attachmentNames: ["reference image.png"],
        clientNonce: "attachment-only-1",
      },
    ],
  ]);
  expect(
    (
      await f.service.handle({
        bot: "a",
        action: "status",
        jobId: sent.job!.id,
      })
    ).job?.state,
  ).toBe("complete");
  expect(
    (await f.service.handle({ bot: "a", action: "status" })).attachments,
  ).toHaveLength(0);
});
test("staged copies are removed synchronously at exit, and a dead server's are swept later", async () => {
  const f = await fixture();
  await f.pick();
  const staged = (f.service as unknown as { rootPath: string }).rootPath;
  expect(staged.startsWith(join(tmpdir(), "voiceos-grok-attachments-"))).toBe(true);
  expect(await readFile(join(staged, ".owner"), "utf8")).toBe(String(process.pid));
  expect((await readdir(staged)).length).toBe(2);
  f.service.cleanupSync();
  expect(await readdir(staged).catch(() => null)).toBeNull();

  const root = await mkdtemp(join(tmpdir(), "grok-sweep-test-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const make = async (name: string, owner?: string, oldMs = 0) => {
    const dir = join(root, `voiceos-grok-attachments-${name}`);
    await mkdir(dir);
    await writeFile(join(dir, "file"), "private");
    if (owner !== undefined) await writeFile(join(dir, ".owner"), owner);
    if (oldMs) await utimes(dir, new Date(Date.now() - oldMs), new Date(Date.now() - oldMs));
  };
  await make("dead", "999991");
  await make("alive", "999992");
  await make("self", String(process.pid));
  await make("legacy-old", undefined, 60 * 60_000);
  await make("legacy-new");
  await mkdir(join(root, "unrelated"));
  await sweepStaleAttachments(root, (pid) => pid === 999992);
  expect((await readdir(root)).sort()).toEqual([
    "unrelated",
    "voiceos-grok-attachments-alive",
    "voiceos-grok-attachments-legacy-new",
    "voiceos-grok-attachments-self",
  ]);
});
test("removal removes the staged attachment without uploading or messaging", async () => {
  const f = await fixture();
  const a = (await f.pick()).attachments[0];
  expect(
    (await f.service.handle({ bot: "a", action: "remove", attachmentId: a.id }))
      .attachments,
  ).toEqual([]);
  expect(f.sends).toEqual([]);
  expect(f.uploads).toEqual([]);
});
test("picker cancellation leaves the draft untouched", async () => {
  const f = await fixture({ pickLocalFiles: async () => [] });
  const r = await f.pick();
  expect(r.job?.state).toBe("cancelled");
  expect(r.attachments).toEqual([]);
});
test("handles and status jobs cannot cross bot boundaries", async () => {
  const f = await fixture();
  const r = await f.pick();
  await expect(
    f.service.handle({
      bot: "b",
      action: "remove",
      attachmentId: r.attachments[0].id,
    }),
  ).rejects.toThrow();
  await expect(
    f.service.handle({ bot: "b", action: "status", jobId: r.job!.id }),
  ).rejects.toThrow();
  await expect(
    f.service.handle({
      bot: "b",
      action: "send",
      attachments: [r.attachments[0].id],
      clientNonce: "different-bot",
    }),
  ).rejects.toThrow();
  expect(f.uploads).toEqual([]);
});
test("retrying a send nonce cannot submit twice", async () => {
  const f = await fixture();
  const r = await f.pick(),
    args = {
      bot: "a",
      action: "send" as const,
      attachments: [r.attachments[0].id],
      message: "Review this",
      clientNonce: "same-nonce",
    };
  const a = await f.service.handle(args);
  await f.service.settled(a.job!.id);
  const b = await f.service.handle(args);
  expect(b.job?.id).toBe(a.job?.id);
  expect(f.sends).toHaveLength(1);
  await expect(
    f.service.handle({ ...args, message: "Different" }),
  ).rejects.toThrow();
});
test("failed upload preserves attachments and does not submit a prompt", async () => {
  const f = await fixture({
    uploadAttachmentChunk: async () => {
      throw Error("network");
    },
  });
  const r = await f.pick(),
    s = await f.service.handle({
      bot: "a",
      action: "send",
      attachments: [r.attachments[0].id],
      clientNonce: "upload-fails",
    });
  await f.service.settled(s.job!.id);
  const status = await f.service.handle({
    bot: "a",
    action: "status",
    jobId: s.job!.id,
  });
  expect(status.job?.state).toBe("failed");
  expect(status.attachments).toHaveLength(1);
  expect(status.attachments[0].sending).toBe(false);
  expect(f.sends).toHaveLength(0);
});
test("unconfirmed delivery is not silently retried", async () => {
  let calls = 0;
  const f = await fixture({
    sendPrompt: async () => {
      calls++;
      throw Error("timeout");
    },
  });
  const r = await f.pick(),
    args = {
      bot: "a",
      action: "send" as const,
      attachments: [r.attachments[0].id],
      clientNonce: "unknown-result",
    };
  const s = await f.service.handle(args);
  await f.service.settled(s.job!.id);
  expect((await f.service.handle(args)).job?.state).toBe("unknown");
  expect(calls).toBe(1);
});
test("invalid selection fails as a batch without retaining partial attachments", async () => {
  const f = await fixture();
  const g = await fixture({
    pickLocalFiles: async () => [f.path, "/missing/test-file"],
  });
  const r = await g.pick();
  expect(r.job?.state).toBe("failed");
  expect(r.attachments).toHaveLength(0);
});
function teaching() {
  let recording = {
    state: "idle" as "idle" | "recording" | "stopping",
    agentId: null as string | null,
    startedAtMs: null as number | null,
    maxDurationMs: 600000,
  };
  const calls: any[] = [];
  const transport: typeof teachTransport = {
    listAgents: async () => [
      { id: "a", name: "Picasso" },
      { id: "b", name: "B" },
      { id: "group", name: "Group", isGroup: true },
    ],
    getTeachRecordingStatus: async () => ({ ...recording }),
    ensureAgentComputer: async (id) => {
      calls.push(["prepare", id]);
      return {};
    },
    agentScreen: async () => ({
      live: true,
      wsUrl: "wss://example.cursorvm.com/vnc",
    }),
    startTeachRecording: async (id) => {
      calls.push(["start", id]);
      return (recording = {
        ...recording,
        state: "recording",
        agentId: id,
        startedAtMs: Date.now(),
      });
    },
    stopTeachRecording: async (id, save) => {
      calls.push(["stop", id, save]);
      return (recording = {
        ...recording,
        state: "idle",
        agentId: null,
        startedAtMs: null,
      });
    },
  };
  return { transport, calls, set: (r: typeof recording) => (recording = r) };
}
test("preparing teaches nothing until the explicit Start recording action", async () => {
  const f = teaching();
  const r = await teachTask("a", "prepare", f.transport);
  expect(f.calls).toEqual([["prepare", "a"]]);
  expect(r.recording.state).toBe("idle");
  // The card demonstrates in the native computer window: no socket URL or
  // in-card viewer bundle travels through the (logged) tool bridge.
  expect(r).toEqual({ ok: true, recording: expect.objectContaining({ state: "idle" }) });
  expect(JSON.stringify(r)).not.toContain("cursorvm");
});
test("preparing fails honestly while the bot's computer is still starting", async () => {
  const f = teaching();
  f.transport.agentScreen = async () => ({ live: false });
  await expect(teachTask("a", "prepare", f.transport)).rejects.toThrow("starting");
});
test("start is idempotent; save uses native stop-and-save with no extra message", async () => {
  const f = teaching();
  await teachTask("a", "start", f.transport);
  await teachTask("a", "start", f.transport);
  const r = await teachTask("a", "save", f.transport);
  expect(f.calls).toEqual([
    ["start", "a"],
    ["stop", "a", true],
  ]);
  expect("saved" in r && r.saved).toBe(true);
});
test("discard uses native stop without saving", async () => {
  const f = teaching();
  await teachTask("a", "start", f.transport);
  await teachTask("a", "discard", f.transport);
  expect(f.calls).toEqual([
    ["start", "a"],
    ["stop", "a", false],
  ]);
});
test("another bot cannot take over or stop an active recording", async () => {
  const f = teaching();
  await teachTask("a", "start", f.transport);
  await expect(teachTask("b", "start", f.transport)).rejects.toThrow(
    "Another bot",
  );
  await expect(teachTask("b", "discard", f.transport)).rejects.toThrow(
    "Another bot",
  );
  await expect(teachTask("group", "prepare", f.transport)).rejects.toThrow(
    "individual",
  );
  expect(f.calls).toEqual([["start", "a"]]);
});
test("every tool the card scripts invoke has an explicit UI grant", () => {
  // The live chat, the composer kit and both glue scripts are what a card runs;
  // any grokbot_* tool they name must be card-callable in the manifest.
  const runtime = [LIVE_CHAT_JS, COMPOSER_KIT_JS, MESSAGING_ADAPTER, SHOW_ADAPTER].join("\n");
  const names = [...new Set([...runtime.matchAll(/['"`](grokbot_[a-z_]+)['"`]/g)].map((m) => m[1]))];
  for (const name of ["grokbot_card_files", "grokbot_card_teach", "grokbot_card_snapshot", "grokbot_open_computer_window"])
    expect(names).toContain(name);
  for (const name of names)
    expect(manifest.tools.find((t) => t.name === name)?.uiCallable, name).toBe(true);
  for (const src of [LIVE_CHAT_JS, COMPOSER_KIT_JS, MESSAGING_ADAPTER, SHOW_ADAPTER]) new Function(src);
});

test("sent receipts keep the plain receipt: the sent text, no live chat or composer kit", async () => {
  const { sentCard, sentGroupCard } = await import("./cards.ts");
  for (const card of [sentCard({ id: "a", name: "Picasso" }, "Already sent"), sentGroupCard([], { id: "group", name: "Team", members: [] }, "Already sent")]) {
    const html = card._voiceos_glance.blocks[0].html;
    const data = JSON.parse(html.match(/^const DEMO=(.*);$/m)![1]);
    expect(data.args.message).toBe("Already sent");
    expect(html).toContain(MESSAGING_ADAPTER);
    expect(html).not.toContain("const LiveChat");
    expect(html).not.toContain("const ComposerKit");
  }
});
