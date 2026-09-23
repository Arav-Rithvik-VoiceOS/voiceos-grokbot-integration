import {
  listAgents,
  transcriptTail,
  respondToWidget,
  dismissWidget,
  openGrokBotApp,
  readAttachmentImage,
  type TranscriptEntry,
} from "./client.ts";
import {
  toThread,
  entryMedia,
  choiceResponse,
  entryState,
  boundThread,
  serializeThreadItem,
  threadItemVersion,
} from "./conversation.ts";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const runFile = promisify(execFile);
export const conversationTransport = {
  listAgents,
  transcriptTail,
  respondToWidget,
  dismissWidget,
  openGrokBotApp,
  readAttachmentImage,
};
type Transport = typeof conversationTransport;

export async function findEntry(
  agentId: string,
  entryId: string,
  transport: Transport = conversationTransport,
): Promise<TranscriptEntry> {
  let before: number | undefined;
  for (let page = 0; page < 10; page++) {
    const tail = await transport.transcriptTail(agentId, 100, before);
    const entry = tail.entries?.find((e) => e.id === entryId);
    if (entry) return entry;
    if (tail.nextBeforeSeq == null || tail.nextBeforeSeq === before) break;
    before = tail.nextBeforeSeq;
  }
  throw new Error(
    "This message is no longer available. Refresh the conversation.",
  );
}

export async function performConversationAction(
  args: {
    bot: string;
    entryId?: string;
    action: "answer" | "dismiss" | "open";
    values?: string[];
    custom?: string;
  },
  transport: Transport = conversationTransport,
) {
  if (args.action === "open") {
    // OAuth, credentials and OS approvals belong to Grok's trusted native flow.
    // Do not pass secrets through the generic (logged) widget tool bridge.
    transport.openGrokBotApp();
    return { ok: true, opened: true };
  }
  if (!(await transport.listAgents()).some((a) => a.id === args.bot))
    throw new Error("This bot is no longer available.");
  const entry = await findEntry(args.bot, args.entryId ?? "", transport);
  if (
    (entry.message as { type?: string })?.type !== "widget" ||
    entryState(entry) !== "pending"
  ) {
    throw new Error(
      "This question has already been answered or dismissed. Refresh the conversation.",
    );
  }
  const result =
    args.action === "answer"
      ? await transport.respondToWidget(
          args.bot,
          entry.id!,
          choiceResponse(entry, args.values ?? [], args.custom),
        )
      : await transport.dismissWidget(args.bot, entry.id!);
  if (result?.accepted === false)
    throw new Error(
      "Grok Bot did not accept the response. Refresh the conversation.",
    );
  return {
    ok: true,
    state: args.action === "answer" ? "resolved" : "dismissed",
  };
}

export async function conversationSnapshot(bot?: string, beforeSeq?: number, transport: Transport = conversationTransport) {
  if (!bot) return { agents: await transport.listAgents(), thread: [] };
  const [agents, tail] = await Promise.all([
    transport.listAgents(),
    transport.transcriptTail(bot, 40, beforeSeq),
  ]);
  if (!agents.some((a) => a.id === bot))
    throw new Error("This bot is no longer available.");
  return {
    agents,
    thread: boundThread(toThread(tail.entries ?? [])),
    nextBeforeSeq: tail.nextBeforeSeq,
  };
}

/** Read a complete transcript entry in bounded chunks; never require an app handoff. */
export async function conversationEntry(
  bot: string,
  entryId: string,
  offset = 0,
  expectedVersion?: string,
  transport: Transport = conversationTransport,
) {
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid message offset.");
  if (!(await transport.listAgents()).some((a) => a.id === bot))
    throw new Error("This bot is no longer available.");
  const entry = await findEntry(bot, entryId, transport);
  const item = toThread([entry])[0];
  if (!item || item.id !== entryId)
    throw new Error("This message is no longer available.");
  const serialized = serializeThreadItem(item),
    version = threadItemVersion(serialized);
  // A message edited between chunks restarts at zero instead of mixing versions.
  const start = expectedVersion === version ? offset : 0;
  if (start > serialized.length) throw new Error("Invalid message offset.");
  const chunk = serialized.slice(start, start + 24_000),
    next = start + chunk.length;
  return {
    ok: true,
    entryId,
    version,
    offset: start,
    chunk,
    nextOffset: next < serialized.length ? next : null,
  };
}

const previews = new Map<string, string>();
/** Cloud file:// references are resolved by Grok, never read from the user's Mac. */
export async function conversationImage(
  bot: string,
  entryId: string,
  index: number,
) {
  const entry = await findEntry(bot, entryId);
  const media = entryMedia(entry)[index];
  if (!media || media.kind !== "image")
    throw new Error("That image is no longer available.");
  if (previews.has(media.source))
    return { dataUrl: previews.get(media.source)! };
  let path: string;
  try {
    const url = new URL(media.source);
    if (
      url.protocol !== "file:" ||
      (url.hostname && url.hostname !== "localhost")
    )
      throw new Error();
    path = decodeURIComponent(url.pathname);
  } catch {
    if (!media.source.startsWith("/"))
      throw new Error("Open this image in Grok Bot.");
    path = media.source;
  }
  const image = await readAttachmentImage(path);
  if (!image?.dataUrl?.match(/^data:image\/(png|jpeg|webp|gif);base64,/))
    throw new Error("This image could not be loaded.");
  let dataUrl = image.dataUrl;
  // Media is loaded separately from HTML. Bound previews to the 128K tool cap.
  if (dataUrl.length > 80_000) {
    const dir = await mkdtemp(join(tmpdir(), "voiceos-grok-preview-"));
    try {
      const input = join(dir, "image");
      const output = join(dir, "preview.jpg");
      const bytes = Buffer.from(dataUrl.split(",")[1], "base64");
      if (bytes.length > 25 * 1024 * 1024)
        throw new Error("This image is too large to preview.");
      await writeFile(input, bytes, { mode: 0o600 });
      for (const size of [720, 480, 320]) {
        await runFile(
          "/usr/bin/sips",
          [
            "-s",
            "format",
            "jpeg",
            "-s",
            "formatOptions",
            "65",
            "-Z",
            String(size),
            input,
            "--out",
            output,
          ],
          { timeout: 10_000 },
        );
        dataUrl = `data:image/jpeg;base64,${(await readFile(output)).toString("base64")}`;
        if (dataUrl.length <= 80_000) break;
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  if (dataUrl.length > 80_000)
    throw new Error("Open this image in Grok Bot to view it.");
  if (previews.size >= 32) previews.delete(previews.keys().next().value!);
  previews.set(media.source, dataUrl);
  return { dataUrl };
}
