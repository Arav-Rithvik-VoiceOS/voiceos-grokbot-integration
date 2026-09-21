import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const runFile = promisify(execFile);
const cache = new Map<string, Promise<string | undefined>>();
export const isAvatarImage = (value: unknown): value is string =>
  typeof value === "string" &&
  /^data:image\/(png|jpeg|webp|gif);base64,[a-z\d+/=]+$/i.test(value);

/** Keep custom avatars small enough to fit a full roster in the card payload. */
export async function avatarThumbnail(value?: string | null) {
  if (!isAvatarImage(value) || value.length > 4_000_000) return undefined;
  if (value.length <= 4000) return value;
  const key = createHash("sha256").update(value).digest("hex");
  const existing = cache.get(key);
  if (existing) return existing;
  const task = (async () => {
    const dir = await mkdtemp(join(tmpdir(), "grok-avatar-"));
    try {
      const input = join(dir, "avatar"),
        output = join(dir, "preview.jpg");
      await writeFile(input, Buffer.from(value.split(",")[1], "base64"));
      await runFile(
        "/usr/bin/sips",
        [
          "-Z",
          "48",
          "-s",
          "format",
          "jpeg",
          "-s",
          "formatOptions",
          "60",
          input,
          "--out",
          output,
        ],
        { timeout: 5000 },
      );
      const picture = `data:image/jpeg;base64,${(await readFile(output)).toString("base64")}`;
      return picture.length <= 4000 ? picture : undefined;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  })().catch(() => undefined);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, task);
  return task;
}
