/** Real browser: a long reply loads completely and scrolls inside the Notch without a click. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { threadCard } from "../cards.ts";
import {
  boundThread,
  toThread,
  serializeThreadItem,
  threadItemVersion,
} from "../conversation.ts";
const dir = process.env.MESSAGE_CHECK_WORK_DIR
  ? resolve(process.env.MESSAGE_CHECK_WORK_DIR)
  : await mkdtemp(join(tmpdir(), "grok-full-message-ui-"));
await mkdir(dir, { recursive: true });
const bot = { id: "a", name: "Sam", avatarColor: "red", avatarShape: "blob" };
const text =
  "How Grok Bot payments work today\n" +
  Array.from(
    { length: 1000 },
    (_, i) =>
      `Detail ${i + 1}: This paragraph must remain readable in the conversation, including its final words.`,
  ).join("\n") +
  "\nFINAL PARAGRAPH — every detail is visible here.";
const item = toThread([
  { id: "long-reply", kind: "message", content: text },
])[0];
const serialized = serializeThreadItem(item),
  version = threadItemVersion(serialized);
const html = threadCard(bot, [
  { id: "long-reply", kind: "message", content: text },
])._voiceos_glance.blocks[0].html;
const bots = [
  { id: "a", name: "Sam", color: "#ff263c", shape: "blob", status: "idle" },
];
const host = `<!doctype html><style>body{margin:0;background:#070707}iframe{border:0;width:430px;height:320px}</style><iframe sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');window.calls=[];window.renderFixture=()=>{};
const serialized=${JSON.stringify(serialized).replace(/</g, "\\u003c")},version=${JSON.stringify(version)};
frame.onload=()=>frame.contentWindow.postMessage({type:'voiceos:init',capabilities:{invokeTool:true}},'*');frame.srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};
addEventListener('message',e=>{const m=e.data;if(e.source!==frame.contentWindow||m.type!=='voiceos:invokeTool')return;calls.push(m);let result={ok:true};
if(m.name==='grokbot_card_files')result={ok:true,attachments:[]};
if(m.name==='grokbot_card_snapshot')result={ok:true,bots:${JSON.stringify(bots)},thread:${JSON.stringify(boundThread([item]))}};
if(m.name==='grokbot_card_entry'){const offset=m.args.version===version?(m.args.offset||0):0,chunk=serialized.slice(offset,offset+24000);result={ok:true,entryId:'long-reply',version,offset,chunk,nextOffset:offset+chunk.length<serialized.length?offset+chunk.length:null};}
setTimeout(()=>frame.contentWindow.postMessage({type:'voiceos:toolResult',requestId:m.requestId,status:'completed',result},'*'),30);
});</script>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () =>
    new Response(host, {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
});
const profile = await mkdtemp(join(dir, "profile-"));
const chrome =
  process.env.CHROME_BINARY ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const child = Bun.spawn(
  [
    chrome,
    "--headless=new",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    "about:blank",
  ],
  { stdout: "ignore", stderr: "ignore" },
);
let ws: WebSocket | undefined;
try {
  let port = "";
  for (let i = 0; i < 50; i++) {
    try {
      port = (
        await readFile(join(profile, "DevToolsActivePort"), "utf8")
      ).split("\n")[0];
      break;
    } catch {
      await Bun.sleep(100);
    }
  }
  assert.ok(port, "Chrome did not start");
  const page = (
    await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  ).find((t: any) => t.type === "page");
  ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws!.addEventListener("open", resolve);
    ws!.addEventListener("error", reject);
  });
  let seq = 0;
  const pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: Timer;
    }
  >();
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(String(e.data));
    const request = pending.get(m.id);
    if (!request) return;
    pending.delete(m.id);
    clearTimeout(request.timer);
    m.error
      ? request.reject(Error(JSON.stringify(m.error)))
      : request.resolve(m.result);
  });
  const call = (method: string, params: object = {}, sessionId?: string) =>
    new Promise<any>((resolve, reject) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(Error(`CDP timeout: ${method}`));
      }, 8000);
      pending.set(id, { resolve, reject, timer });
      ws!.send(JSON.stringify({ id, method, params, sessionId }));
    });
  const evaluate = async (expression: string, sessionId?: string) => {
    const r = await call(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      sessionId,
    );
    if (r.exceptionDetails) throw Error(JSON.stringify(r.exceptionDetails));
    return r.result.value;
  };
  await call("Page.enable");
  await call("Runtime.enable");
  await call("Emulation.setDeviceMetricsOverride", {
    width: 430,
    height: 620,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await call("Page.navigate", {
    url: `http://127.0.0.1:${server.port}/host.html`,
  });
  for (let i = 0; i < 50; i++) {
    if (await evaluate('typeof window.renderFixture === "function"')) break;
    await Bun.sleep(100);
  }
  await Bun.sleep(150);
  const target = (await call("Target.getTargets")).targetInfos.find(
    (t: any) => t.type === "iframe" && t.parentId === page.id,
  );
  assert.ok(target);
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const ui = (code: string) => evaluate(code, sessionId);
  await ui(
    "document.querySelector('#message').value='Keep my draft';document.querySelector('#message').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  for (let i = 0; i < 80; i++) {
    if (
      await ui(
        "document.querySelector('.bubble')?.textContent.includes('FINAL PARAGRAPH')",
      )
    )
      break;
    await Bun.sleep(100);
  }
  const content = await ui("document.querySelector('.bubble').textContent");
  assert.equal(
    content.replaceAll("\n", ""),
    text.replaceAll("\n", ""),
    "every character survives chunking and appears inline",
  );
  assert.equal(
    await ui("document.querySelectorAll('[data-deferred]').length"),
    0,
  );
  assert.equal(
    await ui("document.querySelectorAll('[data-open]').length"),
    0,
    "no app handoff to read text",
  );
  assert.equal(
    await ui("document.querySelector('.header .status').textContent"),
    "Idle",
    "message length is not an approval request",
  );
  assert.equal(
    await ui("document.querySelector('#message').value"),
    "Keep my draft",
  );
  const count = await evaluate(
    "calls.filter(c=>c.name==='grokbot_card_entry').length",
  );
  assert.ok(count >= 4, "loads multiple chunks without clicks");
  await ui("document.dispatchEvent(new Event('visibilitychange'))");
  await Bun.sleep(250);
  assert.equal(
    await evaluate("calls.filter(c=>c.name==='grokbot_card_entry').length"),
    count,
    "refresh reuses the complete message instead of truncating it again",
  );
  assert.equal(
    await ui("document.querySelector('.bubble').textContent"),
    content,
  );
  await ui("document.querySelector('.messages').scrollTop=0");
  assert.ok(
    await ui(
      "document.querySelector('.bubble').getBoundingClientRect().top>=document.querySelector('.messages').getBoundingClientRect().top",
    ),
    "start is reachable",
  );
  await writeFile(
    join(dir, "message-start.png"),
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 210,
    y: 180,
    deltaY: 100000,
    deltaX: 0,
  });
  await Bun.sleep(200);
  assert.ok(
    await ui(
      "(()=>{const s=document.querySelector('.messages');return s.scrollTop>0&&s.scrollHeight-s.scrollTop-s.clientHeight<2})()",
    ),
    "real wheel input reaches the final paragraph",
  );
  assert.ok(
    await ui(
      "(()=>{const c=document.querySelector('.composer').getBoundingClientRect();return c.bottom<=innerHeight})()",
    ),
    "composer stays within the Notch",
  );
  await writeFile(
    join(dir, "message-end.png"),
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      characters: text.length,
      automaticChunkReads: count,
      checks: [
        "complete inline message",
        "no clicks or handoff",
        "draft preserved",
        "refresh preserves loaded text",
        "start and end scroll into view",
        "bounded Notch height",
      ],
    }),
  );
} finally {
  ws?.close();
  server.stop();
  child.kill();
  await child.exited;
  await rm(profile, { recursive: true, force: true });
  if (!process.env.MESSAGE_CHECK_WORK_DIR)
    await rm(dir, { recursive: true, force: true });
}
