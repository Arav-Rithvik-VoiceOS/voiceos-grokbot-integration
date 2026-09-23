import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { mkdtemp, copyFile, stat, open, rm, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import {
  listAgents,
  uploadAttachmentChunk,
  sendPrompt,
  ensureAgentComputer,
  getTeachRecordingStatus,
  startTeachRecording,
  stopTeachRecording,
  agentScreen,
} from "./client.ts";

const runFile = promisify(execFile);
// The native picker is opened only by the user's Attach files click. File paths
// originate here, never in model-authored arguments or an iframe payload.
export const FILE_PICKER_SCRIPT = `
var app = Application.currentApplication();
app.includeStandardAdditions = true;
try {
  var files = app.chooseFile({withPrompt:"Attach files to Grok Bot",multipleSelectionsAllowed:true});
  JSON.stringify(files.map(function(file) { return file.toString(); }));
} catch (error) {
  if (error.errorNumber === -128) { "[]"; } else { throw error; }
}
`;
export async function pickLocalFiles(): Promise<string[]> {
  try {
    const { stdout } = await runFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FILE_PICKER_SCRIPT],
      { timeout: 300_000, maxBuffer: 128_000 },
    );
    const paths: unknown = JSON.parse(stdout.trim());
    if (
      !Array.isArray(paths) ||
      paths.some((p) => typeof p !== "string" || !p.startsWith("/"))
    )
      throw Error();
    return paths;
  } catch {
    throw new Error(
      "The file picker could not finish. Choose Attach files to try again.",
    );
  }
}
export const composerTransport = {
  listAgents,
  uploadAttachmentChunk,
  sendPrompt,
  pickLocalFiles,
};
export type ComposerTransport = typeof composerTransport;
const TTL_MS = 30 * 60_000;
const MAX_FILES = 20;
const MAX_FILE_BYTES = 100 * 1024 * 1024;
type Attachment = {
  id: string;
  bot: string;
  name: string;
  size: number;
  path: string;
  created: number;
  remote?: string;
  locked?: boolean;
};
type Job = {
  id: string;
  bot: string;
  kind: "pick" | "send";
  state: "working" | "complete" | "cancelled" | "failed" | "unknown";
  message?: string;
  created: number;
  fingerprint?: string;
  promise: Promise<void>;
};
export type ComposerArgs = {
  bot: string;
  action: "pick" | "status" | "remove" | "send";
  jobId?: string;
  attachmentId?: string;
  attachments?: string[];
  message?: string;
  clientNonce?: string;
};

/** Private staged bytes and opaque, bot-scoped handles; never attachment names posing as files. */
export class ComposerFiles {
  private entries = new Map<string, Attachment>();
  private jobs = new Map<string, Job>();
  private sends = new Map<string, string>();
  private root?: Promise<string>;
  constructor(
    private transport: ComposerTransport = composerTransport,
    private beforeSend?: (
      bot: string,
      message: string,
    ) => Promise<(() => void) | undefined>,
  ) {}
  private directory() {
    return (this.root ??= mkdtemp(join(tmpdir(), "voiceos-grok-attachments-")));
  }
  private async prune() {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, file] of this.entries)
      if (!file.locked && file.created < cutoff) {
        this.entries.delete(id);
        await rm(file.path, { force: true });
      }
    for (const [id, job] of this.jobs)
      if (job.state !== "working" && job.created < cutoff) this.jobs.delete(id);
    for (const [nonce, id] of this.sends)
      if (!this.jobs.has(id)) this.sends.delete(nonce);
  }
  private list(bot: string) {
    return [...this.entries.values()]
      .filter((f) => f.bot === bot)
      .map(({ id, name, size, locked }) => ({
        id,
        name,
        size,
        sending: !!locked,
      }));
  }
  private snapshot(bot: string, job?: Job) {
    return {
      ok: true,
      attachments: this.list(bot),
      ...(job
        ? {
            job: {
              id: job.id,
              kind: job.kind,
              state: job.state,
              message: job.message,
            },
          }
        : {}),
    };
  }
  private launch(
    bot: string,
    kind: Job["kind"],
    task: (job: Job) => Promise<void>,
    fingerprint?: string,
  ) {
    const job: Job = {
      id: randomUUID(),
      bot,
      kind,
      state: "working",
      created: Date.now(),
      fingerprint,
      promise: Promise.resolve(),
    };
    this.jobs.set(job.id, job);
    job.promise = Promise.resolve()
      .then(() => task(job))
      .then(
        () => {
          if (job.state === "working") job.state = "complete";
        },
        () => {
          if (job.state === "working") {
            job.state = "failed";
            job.message =
              "The attachment operation failed. Your draft is still here.";
          }
        },
      );
    return job;
  }
  private async stage(bot: string, job: Job) {
    const paths = await this.transport.pickLocalFiles();
    if (!paths.length) {
      job.state = "cancelled";
      return;
    }
    if (paths.length + this.list(bot).length > MAX_FILES) {
      job.state = "failed";
      job.message = `Attach up to ${MAX_FILES} files at a time.`;
      return;
    }
    const staged: Attachment[] = [];
    try {
      for (const path of paths) {
        const info = await stat(path);
        if (!info.isFile() || !info.size || info.size > MAX_FILE_BYTES)
          throw Error("Choose nonempty files up to 100 MB each.");
        const id = randomUUID(),
          target = join(await this.directory(), id);
        try {
          await copyFile(path, target);
          await chmod(target, 0o600);
        } catch (error) {
          await rm(target, { force: true });
          throw error;
        }
        const copied = await stat(target);
        if (copied.size !== info.size) {
          await rm(target, { force: true });
          throw Error("A selected file changed. Please choose it again.");
        }
        staged.push({
          id,
          bot,
          name: basename(path),
          size: copied.size,
          path: target,
          created: Date.now(),
        });
      }
      for (const file of staged) this.entries.set(file.id, file);
    } catch (error) {
      await Promise.all(staged.map((f) => rm(f.path, { force: true })));
      job.state = "failed";
      job.message =
        error instanceof Error &&
        [
          "Choose nonempty files up to 100 MB each.",
          "A selected file changed. Please choose it again.",
        ].includes(error.message)
          ? error.message
          : "A selected file could not be read. Choose it again.";
    }
  }
  private async upload(file: Attachment) {
    if (file.remote) return file.remote;
    const reader = await open(file.path, "r"),
      uploadId = randomUUID();
    try {
      const bytes = Buffer.alloc(Math.min(256 * 1024, file.size));
      for (let offset = 0; offset < file.size; ) {
        const { bytesRead } = await reader.read(
          bytes,
          0,
          Math.min(bytes.length, file.size - offset),
          offset,
        );
        if (!bytesRead) throw Error("Incomplete staged file");
        const result = await this.transport.uploadAttachmentChunk({
          agentId: file.bot,
          uploadId,
          filename: file.name,
          offset,
          totalSize: file.size,
          bytesBase64: bytes.toString("base64", 0, bytesRead),
        });
        offset += bytesRead;
        if (result.committedPath) {
          if (offset !== file.size || !result.committedPath.startsWith("/"))
            throw Error("Invalid upload result");
          file.remote = result.committedPath;
          return file.remote;
        }
      }
      throw Error("Grok did not commit the attachment");
    } finally {
      await reader.close();
    }
  }
  async handle(args: ComposerArgs) {
    await this.prune();
    if (!(await this.transport.listAgents()).some((a) => a.id === args.bot))
      throw Error("This bot is no longer available.");
    if (args.action === "status") {
      const job = args.jobId
        ? this.jobs.get(args.jobId)
        : [...this.jobs.values()]
            .reverse()
            .find((j) => j.bot === args.bot && j.state === "working");
      if (args.jobId && (!job || job.bot !== args.bot))
        throw Error("This attachment session has expired.");
      return this.snapshot(args.bot, job);
    }
    if (args.action === "remove") {
      const file = this.entries.get(args.attachmentId ?? "");
      if (!file || file.bot !== args.bot)
        throw Error("This attachment is no longer available.");
      if (file.locked) throw Error("Wait for the current send to finish.");
      this.entries.delete(file.id);
      await rm(file.path, { force: true });
      return this.snapshot(args.bot);
    }
    if (args.action === "pick") {
      const active = [...this.jobs.values()].find(
        (j) => j.kind === "pick" && j.state === "working",
      );
      if (active) {
        if (active.bot !== args.bot)
          throw Error("Finish the open file picker first.");
        return this.snapshot(args.bot, active);
      }
      const job = this.launch(args.bot, "pick", (j) => this.stage(args.bot, j));
      return this.snapshot(args.bot, job);
    }
    const ids = [...new Set(args.attachments ?? [])];
    const message = args.message?.trim() ?? "";
    const nonce = args.clientNonce;
    if (!nonce || !/^[a-zA-Z0-9_-]{8,128}$/.test(nonce))
      throw Error("Reopen the composer before sending.");
    if (!ids.length || ids.length > MAX_FILES)
      throw Error("Choose files to attach first.");
    const fingerprint = JSON.stringify([args.bot, ids, message]);
    const existing = this.jobs.get(this.sends.get(nonce) ?? "");
    if (existing) {
      if (existing.fingerprint !== fingerprint)
        throw Error("This send belongs to a different draft.");
      return this.snapshot(args.bot, existing);
    }
    const files = ids.map((id) => this.entries.get(id));
    if (files.some((f) => !f || f.bot !== args.bot || f.locked))
      throw Error("An attachment is unavailable or already sending.");
    for (const file of files) file!.locked = true;
    const job = this.launch(
      args.bot,
      "send",
      async (j) => {
        let submitting = false;
        try {
          const attachmentPaths: string[] = [];
          for (const file of files)
            attachmentPaths.push(await this.upload(file!));
          const notify = await this.beforeSend?.(args.bot, message).catch(
            () => undefined,
          );
          submitting = true;
          const result = await this.transport.sendPrompt(args.bot, message, {
            attachmentPaths,
            attachmentNames: files.map((f) => f!.name),
            clientNonce: nonce,
          });
          if (result?.accepted === false) {
            submitting = false;
            throw Error("Rejected");
          }
          for (const file of files) {
            this.entries.delete(file!.id);
            await rm(file!.path, { force: true }).catch(() => {});
          }
          try {
            notify?.();
          } catch {
            /* Delivery already succeeded. */
          }
        } catch {
          j.state = submitting ? "unknown" : "failed";
          j.message = submitting
            ? "Delivery is unconfirmed. Check the conversation before sending again."
            : "The files could not be sent. Your draft and attachments are preserved.";
        } finally {
          for (const file of files) file!.locked = false;
        }
      },
      fingerprint,
    );
    this.sends.set(nonce, job.id);
    return this.snapshot(args.bot, job);
  }
  async settled(jobId: string) {
    await this.jobs.get(jobId)?.promise;
  }
  async dispose() {
    await Promise.all([...this.jobs.values()].map((j) => j.promise));
    if (this.root) await rm(await this.root, { recursive: true, force: true });
    this.entries.clear();
    this.jobs.clear();
    this.sends.clear();
  }
}

export const teachTransport = {
  listAgents,
  ensureAgentComputer,
  getTeachRecordingStatus,
  startTeachRecording,
  stopTeachRecording,
  agentScreen,
};
export type TeachAction = "prepare" | "status" | "start" | "save" | "discard";
export async function teachTask(
  bot: string,
  action: TeachAction,
  transport = teachTransport,
) {
  const agent = (await transport.listAgents()).find((a) => a.id === bot);
  if (!agent || agent.isGroup)
    throw Error("Teach a task is available for an individual bot.");
  const status = await transport.getTeachRecordingStatus();
  if (action === "status") return { ok: true, recording: status };
  if (status.state !== "idle" && status.agentId !== bot)
    throw Error("Another bot is recording. Finish that recording first.");
  if (action === "prepare") {
    await transport.ensureAgentComputer(bot);
    const screen = await transport.agentScreen(bot);
    if (!screen.live || !screen.wsUrl)
      throw Error(
        "The bot’s computer is starting. Try Teach a task again in a moment.",
      );
    // Ready only: the card hands the user the native interactive computer
    // window (grokbot_open_computer_window), so no socket URL or in-card
    // viewer bundle rides in this result.
    return { ok: true, recording: status };
  }
  if (action === "start") {
    const recording =
      status.state === "recording"
        ? status
        : await transport.startTeachRecording(bot);
    if (recording.state !== "recording" || recording.agentId !== bot)
      throw Error("Recording did not start. Please try again.");
    return { ok: true, recording };
  }
  // Grok itself attaches the saved demonstration and asks the bot to learn it.
  // Sending a second synthetic prompt here would duplicate the native action.
  const recording =
    status.state === "idle"
      ? status
      : await transport.stopTeachRecording(bot, action === "save");
  if (recording.state === "recording")
    throw Error("Recording is still active. Try Stop again.");
  return {
    ok: true,
    recording,
    saved: action === "save" && status.state !== "idle",
  };
}
