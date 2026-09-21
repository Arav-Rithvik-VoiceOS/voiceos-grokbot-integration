/** Headless browser coverage of real Grok composer UI; every external action is mocked. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { renderConversationCard } from "../conversationWidget.ts";
const dir = process.env.COMPOSER_CHECK_WORK_DIR
  ? resolve(process.env.COMPOSER_CHECK_WORK_DIR)
  : await mkdtemp(join(tmpdir(), "grok-composer-ui-"));
await mkdir(dir, { recursive: true });
const bots = [
  {
    id: "a",
    name: "Picasso",
    color: "#ff9900",
    shape: "teardrop",
    status: "idle",
  },
];
const html = renderConversationCard({
  data: {
    bots,
    thread: [
      {
        id: "hello",
        from: "bot",
        text: "Here’s C without the logo shadow — midtone background, white wordmark composited clean.",
      },
    ],
  },
  args: { bot: "a" },
});
const viewer = gzipSync(
  Buffer.from(
    `export default class extends EventTarget { constructor(el,url){super();el.textContent='Mock bot computer';setTimeout(()=>this.dispatchEvent(new Event('connect')),20);} disconnect(){} }`,
  ),
).toString("base64");
const host = `<!doctype html><style>body{margin:0;background:#070707}iframe{border:0;width:430px;height:410px}</style><iframe sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');window.calls=[];window.files=[];window.job=null;window.failSend=false;window.recording={state:'idle',agentId:null,startedAtMs:null,maxDurationMs:600000};window.renderFixture=()=>{};
frame.onload=()=>frame.contentWindow.postMessage({type:'voiceos:init',capabilities:{invokeTool:true}},'*');frame.srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};
addEventListener('message',e=>{const m=e.data;if(e.source!==frame.contentWindow||m.type!=='voiceos:invokeTool')return;calls.push(m);let result={ok:true};
if(m.name==='grokbot_card_snapshot')result={ok:true,bots:${JSON.stringify(bots)},thread:[]};
if(m.name==='grokbot_card_files'){
 const a=m.args.action;if(a==='pick'){files=[{id:'file-1',name:'reference.png',size:128,sending:false}];job={id:'pick-1',kind:'pick',state:'complete'};}
 if(a==='remove'){files=[];job=null;}
 if(a==='send'){job={id:'send-1',kind:'send',state:'working'};files=files.map(f=>({...f,sending:true}));}
 if(a==='status'&&job?.kind==='send'){job={...job,state:failSend?'failed':'complete',message:failSend?'Upload failed; draft preserved':undefined};files=failSend?files.map(f=>({...f,sending:false})):[];}
 result={ok:true,attachments:files,job};
}
if(m.name==='grokbot_card_send')result={sent:true};
if(m.name==='grokbot_card_teach'){
 if(m.args.action==='start')recording={...recording,state:'recording',agentId:'a',startedAtMs:Date.now()};
 if(['save','discard'].includes(m.args.action))recording={...recording,state:'idle',agentId:null,startedAtMs:null};
 result={ok:true,recording,saved:m.args.action==='save',...(m.args.action==='prepare'?{wsUrl:'wss://test.cursorvm.com/vnc',viewer:${JSON.stringify(viewer)}}:{})};
}
setTimeout(()=>frame.contentWindow.postMessage({type:'voiceos:toolResult',requestId:m.requestId,status:'completed',result},'*'),20);
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
  await Bun.sleep(300);
  const target = (await call("Target.getTargets")).targetInfos.find(
    (t: any) => t.type === "iframe" && t.parentId === page.id,
  );
  assert.ok(target, "composer iframe mounted");
  const { sessionId } = await call("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: true,
  });
  const ui = (code: string) => evaluate(code, sessionId);
  assert.equal(
    await ui("document.querySelector('[data-refresh]')"),
    null,
    "conversation updates without a reload button",
  );
  const click = async (selector: string) => {
    await ui(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await Bun.sleep(100);
  };
  const type = async (text: string) => {
    await ui(
      `document.querySelector('#message').value=${JSON.stringify(text)};document.querySelector('#message').dispatchEvent(new Event('input',{bubbles:true}))`,
    );
  };
  for (const height of [160, 220, 410]) {
    await evaluate(
      `document.querySelector('iframe').style.height='${height}px'`,
    );
    await click("#attach");
    assert.deepEqual(
      await ui(
        "[...document.querySelectorAll('[role=menuitem]')].map(b=>b.textContent.trim())",
      ),
      ["Attach files", "Teach a task"],
    );
    assert.ok(
      await ui(
        "(()=>{const r=document.querySelector('.composer-menu').getBoundingClientRect();return r.top>=0&&r.bottom<=innerHeight})()",
      ),
      "menu fits " + height,
    );
    await ui(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
    );
    assert.ok(await ui("document.activeElement.hasAttribute('data-teach')"));
    if (height === 410) {
      const shot = await call("Page.captureScreenshot", { format: "png" });
      await writeFile(
        join(dir, "plus-menu.png"),
        Buffer.from(shot.data, "base64"),
      );
    }
    await ui(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.ok(await ui("document.querySelector('.composer-menu').hidden"));
  }
  await click("#attach");
  await click("[data-pick-files]");
  assert.equal(
    await ui("document.querySelectorAll('.attachment-chip').length"),
    1,
  );
  assert.equal(
    await ui("document.querySelector('#send').disabled"),
    false,
    "attachment-only send enabled",
  );
  await click("[data-remove-file]");
  assert.equal(
    await ui("document.querySelectorAll('.attachment-chip').length"),
    0,
  );
  await click("#attach");
  await click("[data-pick-files]");
  await click("#send");
  await type("Next draft");
  await click("[data-check-files]");
  assert.equal(
    await ui("document.querySelector('#message').value"),
    "Next draft",
  );
  assert.equal(
    await ui("document.querySelectorAll('.attachment-chip').length"),
    0,
  );
  const sends = await evaluate(
    "calls.filter(c=>c.name==='grokbot_card_files'&&c.args.action==='send')",
  );
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].args.attachments, ["file-1"]);
  assert.equal(sends[0].args.message, "");
  await evaluate("failSend=true");
  await click("#attach");
  await click("[data-pick-files]");
  await click("#send");
  await click("[data-check-files]");
  assert.equal(
    await ui("document.querySelector('#message').value"),
    "Next draft",
  );
  assert.equal(
    await ui("document.querySelectorAll('.attachment-chip').length"),
    1,
  );
  await click("#attach");
  await click("[data-teach]");
  await Bun.sleep(150);
  assert.equal(
    await ui("document.querySelector('[data-start-teach]').disabled"),
    false,
    "computer connected",
  );
  assert.equal(
    (
      await evaluate(
        "calls.filter(c=>c.name==='grokbot_card_teach'&&c.args.action==='start')",
      )
    ).length,
    0,
    "opening menu never starts recording",
  );
  await click("[data-start-teach]");
  assert.ok(
    await ui(
      "!document.querySelector('.teach-panel [data-save-teach]').hidden",
    ),
  );
  await click("[data-close-teach]");
  assert.ok(
    await ui("!document.querySelector('.record-banner').hidden"),
    "recording controls persist after closing computer",
  );
  await click("[data-resume-teach]");
  await Bun.sleep(100);
  await click(".teach-panel [data-save-teach]");
  assert.ok(await ui("document.querySelector('.teach-panel').hidden"));
  await click("#attach");
  await click("[data-teach]");
  await Bun.sleep(100);
  await click("[data-start-teach]");
  await click("[data-discard-teach]");
  assert.deepEqual(
    await evaluate(
      "calls.filter(c=>c.name==='grokbot_card_teach'&&['start','save','discard'].includes(c.args.action)).map(c=>c.args.action)",
    ),
    ["start", "save", "start", "discard"],
  );
  assert.equal(
    (await evaluate("calls.filter(c=>c.name==='grokbot_card_send')")).length,
    0,
    "teach uses native recording, not a synthetic message",
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "menu labels",
        "menu fits 160/220/410px",
        "keyboard navigation",
        "staging",
        "removal",
        "attachment-only send",
        "new draft preserved",
        "failed upload preserves draft and files",
        "prepare without recording",
        "start",
        "persistent stop controls",
        "save",
        "discard",
      ],
    }),
  );
} finally {
  ws?.close();
  server.stop();
  child.kill();
  await child.exited;
  await rm(profile, { recursive: true, force: true });
  if (!process.env.COMPOSER_CHECK_WORK_DIR)
    await rm(dir, { recursive: true, force: true });
}
