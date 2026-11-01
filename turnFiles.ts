// A local MCP caller may name a staged file only under this installation's grant.
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { IntegrationError } from "./client.ts";

export type GrokFile = { name: string; data: Buffer };
export const FILES_DESCRIPTION =
  "Files to attach to the message. Pass the attached_file_N references from this turn.";
const LIMIT_BYTES = 10 * 1024 * 1024;

export async function readTurnFiles(
  paths: string[] | undefined,
  grant: unknown,
): Promise<GrokFile[]> {
  if (!paths?.length) return [];
  const capability = grant as
    | { version?: number; inputsRoot?: string }
    | undefined;
  if (
    capability?.version !== 1 ||
    typeof capability.inputsRoot !== "string" ||
    !isAbsolute(capability.inputsRoot)
  )
    throw new IntegrationError(
      "upstream",
      "This VoiceOS host cannot pass files to Grok Bot. Update VoiceOS and try again.",
    );
  try {
    if (paths.length > 6) throw new Error("file limit");
    const root = await realpath(capability.inputsRoot);
    const files: GrokFile[] = [];
    let total = 0;
    for (const path of paths) {
      // VoiceOS gives every dispatch a new directory and sanitizes the filename.
      const parts = relative(capability.inputsRoot, path).split(sep);
      if (
        !isAbsolute(path) ||
        parts.length !== 2 ||
        parts[0] === ".." ||
        !parts[1] ||
        (await realpath(path)) !== join(root, ...parts) ||
        !(await lstat(path)).isFile()
      )
        throw new Error("invalid path");
      const file = await open(
        path,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || !info.size || info.size + total > LIMIT_BYTES)
          throw new Error("invalid size");
        const bytes = Buffer.alloc(info.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(
            bytes,
            offset,
            bytes.length - offset,
            offset,
          );
          if (!read.bytesRead) throw new Error("incomplete file");
          offset += read.bytesRead;
        }
        total += bytes.length;
        files.push({ name: basename(path), data: bytes });
      } finally {
        await file.close();
      }
    }
    return files;
  } catch {
    throw new IntegrationError(
      "upstream",
      "Cannot read the attached file from this VoiceOS installation. Attach up to six files totaling at most 10 MiB.",
    );
  }
}
