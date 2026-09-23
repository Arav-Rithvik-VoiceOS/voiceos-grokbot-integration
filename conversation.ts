import { createHash } from "node:crypto";
import type { TranscriptEntry } from "./client.ts";
import { renderMarkdown, escapeHtml, markdownImages } from "./markdown.ts";
import {
  object,
  string,
  entryState,
  requestCard,
  type EntryState,
  type RequestCard,
} from "./requestState.ts";
export { escapeHtml } from "./markdown.ts";
export { entryState } from "./requestState.ts";

export interface Media {
  source: string;
  name: string;
  kind: "image" | "video" | "audio" | "file";
}
export interface Choice {
  prompt: string;
  options: { label: string; value: string; description?: string }[];
  multiSelect: boolean;
  allowCustom: boolean;
}
export interface ThreadItem {
  id: string;
  from: "me" | "bot";
  bot?: string;
  sender?: string;
  text?: string;
  html?: string;
  sys?: string;
  media?: Media[];
  choice?: Choice;
  request?: RequestCard;
  state?: EntryState;
  answer?: string;
  timestampMs?: number;
  deferred?: { version: string; attention: boolean };
}

export function mediaKind(source: string): Media["kind"] {
  const path = source.split(/[?#]/)[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|heic|bmp|svg)$/.test(path)) return "image";
  if (/\.(mp4|mov|webm|m4v)$/.test(path)) return "video";
  if (/\.(mp3|wav|m4a|aac|ogg|flac)$/.test(path)) return "audio";
  return "file";
}

export function entryMedia(e: TranscriptEntry): Media[] {
  const m = object(e.message);
  const out: Media[] = [];
  const add = (source: unknown, name: unknown, image = false) => {
    if (
      typeof source !== "string" ||
      !source ||
      out.some((v) => v.source === source)
    )
      return;
    out.push({
      source,
      name:
        string(name) || source.split("/").pop()?.split("?")[0] || "Attachment",
      kind: image ? "image" : mediaKind(source),
    });
  };
  if (e.kind === "user-attachment") add(e.file_path, e.file_name);
  if (m.type === "attachment") add(m.url, m.file_name);
  for (const image of [
    ...(Array.isArray(m.images) ? m.images : []),
    ...(e.images ?? []),
  ]) {
    add(image.url, image.alt, true);
  }
  // Grok also accepts markdown image references in ordinary text.
  const text = string(m.content) || string(e.content);
  for (const image of markdownImages(text)) add(image.url, image.alt, true);
  return out;
}

/** Preserve every user-facing Grok message; never stringify structured content. */
export function toThread(entries: TranscriptEntry[]): ThreadItem[] {
  const items: ThreadItem[] = [];
  for (const [index, e] of entries.entries()) {
    const m = object(e.message);
    const item: ThreadItem = {
      id: e.id ?? `entry-${index}`,
      from: e.role === "user" && !e.fromAgent ? "me" : "bot",
      bot: e.author?.id ?? e.fromAgent?.id,
      sender: e.author?.name ?? e.fromAgent?.name,
      timestampMs: e.timestampMs,
    };
    if (e.toAgent) {
      items.push({
        ...item,
        sys: "Messaged",
        bot: e.toAgent.id,
        sender: e.toAgent.name,
      });
      continue;
    }
    if (e.kind === "notice") {
      items.push({ ...item, sys: string(e.text) });
      continue;
    }
    if (!["message", "send-message", "user-attachment"].includes(e.kind ?? ""))
      continue;
    item.text = (
      string(e.content) ||
      string(m.content) ||
      string(e.message)
    ).trim();
    item.html = renderMarkdown(item.text);
    item.media = entryMedia(e);
    if (e.kind === "user-attachment") item.from = "me";
    if (m.type === "widget") {
      const w = object(m.widget);
      item.choice = {
        prompt: string(w.prompt),
        multiSelect: w.multiSelect === true,
        allowCustom: w.allowCustom === true,
        options: (Array.isArray(w.options) ? w.options : []).map((o: any) => ({
          label: string(o.label),
          value: string(o.value ?? o.label),
          description: string(o.description),
        })),
      };
      item.state = entryState(e);
      item.answer = string(e.respondedValue);
    } else if (m.type && !["text", "attachment"].includes(m.type)) {
      item.request = requestCard(e);
      item.state = entryState(e);
    }
    if (item.text || item.media.length || item.choice || item.request)
      items.push(item);
  }
  return items;
}

export function needsAttention(items: ThreadItem[]): boolean {
  return items.some(
    (i) =>
      i.deferred?.attention ||
      (i.state === "pending" && (!!i.choice || i.request?.attention === true)),
  );
}

/** Markup is server-rendered and sanitized; it must survive deferred loading. */
export function serializeThreadItem(item: ThreadItem): string {
  return JSON.stringify(item);
}
export function threadItemVersion(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex").slice(0, 24);
}

/** Share the total budget; ordinary long replies are never cut to a per-row quota.
 * Oversized entries retain their IDs and load automatically through the chunk reader.
 */
export function boundThread(
  items: ThreadItem[],
  maxChars = 48_000,
): ThreadItem[] {
  const full = items;
  const encoded = full.map(serializeThreadItem);
  let size = encoded.reduce(
    (sum, item) => sum + item.length,
    2 + Math.max(0, full.length - 1),
  );
  if (size <= maxChars) return full;
  const result = [...full];
  for (const index of full
    .map((_, i) => i)
    .sort((a, b) => encoded[b].length - encoded[a].length)) {
    if (size <= maxChars) break;
    const item = full[index];
    const preview: ThreadItem = {
      id: item.id,
      from: item.from,
      timestampMs: item.timestampMs,
      sender: item.sender?.slice(0, 100),
      bot: item.bot,
      text: item.text?.slice(0, 160),
      deferred: {
        version: threadItemVersion(encoded[index]),
        attention: needsAttention([item]),
      },
    };
    const previewSize = JSON.stringify(preview).length;
    if (previewSize >= encoded[index].length) continue;
    result[index] = preview;
    size += previewSize - encoded[index].length;
  }
  return result;
}

/** Validate against a fresh request, not arguments supplied by a stale iframe. */
export function choiceResponse(
  e: TranscriptEntry,
  values: string[],
  custom = "",
): string {
  const item = toThread([e])[0];
  if (!item?.choice || item.state !== "pending")
    throw new Error(
      "This question has already been answered or dismissed. Refresh the conversation.",
    );
  const w = item.choice;
  const selected = [...new Set(values)];
  if (selected.some((v) => !w.options.some((o) => o.value === v)))
    throw new Error("That option is no longer available.");
  if (custom.trim() && !w.allowCustom)
    throw new Error("This question does not accept a custom answer.");
  if (!w.multiSelect && selected.length + Number(!!custom.trim()) > 1)
    throw new Error("Choose one answer.");
  const answer = [
    ...w.options.filter((o) => selected.includes(o.value)).map((o) => o.value),
    custom.trim(),
  ]
    .map((value) =>
      w.multiSelect ? value.replace(/\s*\n\s*/g, " ").trim() : value,
    )
    .filter(Boolean)
    .join("\n");
  if (!answer) throw new Error("Choose an answer first.");
  return answer;
}
