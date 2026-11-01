import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTurnFiles } from "../turnFiles.ts";
import { sendPrompt, type gateway } from "../client.ts";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture(name: string, bytes: Buffer) {
  const root = await mkdtemp(join(tmpdir(), "grokbot-turnfiles-"));
  roots.push(root);
  const dir = join(root, "scope");
  await mkdir(dir);
  const file = join(dir, name);
  await writeFile(file, bytes);
  return { root, dir, file, grant: { version: 1, inputsRoot: root } };
}
test.each(["hat.png", "dance.mp4"])(
  "uploads the complete %s then sends only the committed path to the selected bot",
  async (name) => {
    const bytes = Buffer.alloc(410_000, 23);
    const f = await fixture(name, bytes);
    const files = await readTurnFiles([f.file], f.grant);
    let offset = 0,
      id = "";
    const commands: string[] = [];
    const call = async (method: string, args: any, options: any) => {
      commands.push(method);
      expect(args.agentId).toBe("test-bot");
      expect(options.noReplay).toBe(true);
      if (method === "uploadAttachmentChunk") {
        expect(args.totalSize).toBe(bytes.length);
        expect(args.filename).toBe(name);
        expect(args.offset).toBe(offset);
        const part = Buffer.from(args.bytesBase64, "base64");
        expect(part).toEqual(bytes.subarray(offset, offset + part.length));
        id ||= args.uploadId;
        expect(args.uploadId).toBe(id);
        offset += part.length;
        return {
          committedPath: offset === bytes.length ? "/box/test-file" : null,
        };
      }
      expect(args.prompt).toBe("");
      expect(args.attachmentPaths).toEqual(["/box/test-file"]);
      expect(args.attachmentNames).toEqual([name]);
      expect(JSON.stringify(args)).not.toContain(f.root);
      return { accepted: true };
    };
    expect(
      await sendPrompt("test-bot", "", files, call as typeof gateway),
    ).toMatchObject({ accepted: true });
    expect(commands).toEqual([
      "uploadAttachmentChunk",
      "uploadAttachmentChunk",
      "sendPrompt",
    ]);
  },
);
test("never sends a caption/plain message if any requested upload fails", async () => {
  const commands: string[] = [];
  const call = async (method: string) => {
    commands.push(method);
    if (commands.length === 1) return { committedPath: "/box/first" };
    throw Error("lost");
  };
  await expect(
    sendPrompt(
      "test-bot",
      "look",
      [
        { name: "a.png", data: Buffer.from("a") },
        { name: "b.mp4", data: Buffer.from("b") },
      ],
      call as typeof gateway,
    ),
  ).rejects.toThrow(/No message was sent/);
  expect(commands).toEqual(["uploadAttachmentChunk", "uploadAttachmentChunk"]);
});
test("an unconfirmed file send never retries the message", async () => {
  const commands: string[] = [];
  const call = async (method: string) => {
    commands.push(method);
    return method === "uploadAttachmentChunk"
      ? { committedPath: "/box/test" }
      : { accepted: false };
  };
  await expect(
    sendPrompt(
      "test-bot",
      "look",
      [{ name: "a.png", data: Buffer.from("a") }],
      call as typeof gateway,
    ),
  ).rejects.toThrow(/did not confirm/);
  expect(commands).toEqual(["uploadAttachmentChunk", "sendPrompt"]);
});
test("rejects ungranted files, guessed local paths and symlink escapes", async () => {
  const inside = await fixture("image.png", Buffer.from("image")),
    outside = await fixture("video.mp4", Buffer.from("video"));
  for (const [path, grant] of [
    [inside.file, undefined],
    [outside.file, inside.grant],
  ] as const)
    await expect(readTurnFiles([path], grant)).rejects.toThrow();
  const linked = join(inside.dir, "link.png");
  await symlink(outside.file, linked);
  await expect(readTurnFiles([linked], inside.grant)).rejects.toThrow();
});
