import { IntegrationError } from "./client.ts";

// VoiceOS passes references in the normal tool arguments and their bytes in
// the local MCP request metadata. Model text can never select a filesystem path.
export const FILE_LIMIT = 4 * 1024 * 1024;
export const FILES_DESCRIPTION = "To send files attached to this VoiceOS request, put their attached_file_N references here. Include only the files the user wants sent, up to four files of 4 MB each. Never put paths or attachment references in the message instead.";
const MAX_BASE64 = 4 * Math.ceil(FILE_LIMIT / 3);

export function checkAttachmentData(base64: string) {
  if (base64.length > MAX_BASE64 || Buffer.from(base64, "base64").length > FILE_LIMIT)
    throw new IntegrationError("upstream", "Grok Bot accepts files up to 4 MB each.");
}

export function notchAttachments(refs: string[] | undefined, metadata?: Record<string, unknown>) {
  if (!refs?.length) return [];
  if (refs.length > 4 || new Set(refs).size !== refs.length)
    throw new IntegrationError("upstream", "Choose up to four distinct files attached to this request.");
  const files = metadata?.["com.voiceos/attachments"];
  return refs.map(ref => {
    const file = files && typeof files === "object" && /^attached_file_\d+$/.test(ref)
      ? (files as Record<string, { name?: unknown; base64?: unknown }>)[ref] : undefined;
    if (typeof file?.name !== "string" || typeof file.base64 !== "string")
      throw new IntegrationError("upstream", "VoiceOS could not find this attachment. Attach the file again.");
    checkAttachmentData(file.base64);
    if (file.base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.base64))
      throw new IntegrationError("upstream", "VoiceOS could not read the attached file.");
    const name = file.name.split(/[\\/]/).pop()?.replace(/[:\0]/g, "_").trim().slice(0, 255) || "file";
    return { name, base64: file.base64 };
  });
}
