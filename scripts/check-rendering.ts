/** Real browser: rich messages and live approval states fit the actual sandboxed card. */
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
const dir = process.env.RENDERING_CHECK_WORK_DIR
  ? resolve(process.env.RENDERING_CHECK_WORK_DIR)
  : await mkdtemp(join(tmpdir(), "grok-rendering-ui-"));
await mkdir(dir, { recursive: true });
const bot = {
  id: "a",
  name: "Jonah Bot",
  avatarColor: "gray",
  avatarShape: "blob",
};
const text = [
  "## Operational signals",
  "| Message | Events (30d) | What it actually is |",
  "| :--- | ---: | :--- |",
  "| `electron_child_process_gone` | ~188k | GPU/child process exited |",
  "| `main_event_loop_stall` | ~75k | Main-thread stall telemetry |",
  "| `keyboard_event_delivery_delay` | ~21k | Key delivery >500ms |",
  "| `keyboard_tap_slow` | ~10k | Slow tap telemetry |",
  "| `main_memory_sample` | ~8.5k | Memory sampling as error events |",
  "",
  "What I’d change first:",
  "",
  "1. Stop sending `main_memory_sample` as errors.",
  "2. Keep real exceptions.",
  "   - Use **metrics** and *logs*.",
  "",
  "> Preserve ~~old~~ useful context.",
  "",
  "- [x] Checked",
  "- [ ] Pending",
  "",
  "```typescript",
  "const count = 10;",
  'console.log("hello");',
  "```",
  "",
  "Math: $x^2$.",
  "",
  "[Reference](https://example.com/docs)",
].join("\n");
const makeEntries = (status: string) => [
  {
    id: "connection",
    kind: "send-message",
    message: { type: "scm-connect", provider: "GitHub" },
  },
  { id: "rich-message", kind: "message", content: text },
  {
    id: "approval",
    kind: "send-message",
    message: {
      type: "auto-review-approval",
      approval: {
        status,
        summary:
          "Approve PR 182 on voiceos-dictation as Jonah with user-Github",
        reason: "Review requested",
        command: "gh pr review 182 --approve",
      },
    },
  },
];
const entries = makeEntries("expired");
const card = threadCard(bot, entries);
assert.ok(
  JSON.stringify({ blocks: card._voiceos_glance.blocks }).length < 96000,
  "rich card fits the transport budget",
);
const html = card._voiceos_glance.blocks[0].html;
const snapshots = Object.fromEntries(
  ["expired", "pending", "denied", "approved"].map((s) => [
    s,
    toThread(makeEntries(s)),
  ]),
);
const bots = [
  {
    id: "a",
    name: "Jonah Bot",
    color: "#777777",
    shape: "blob",
    status: "idle",
  },
];
const host = `<!doctype html><style>body{margin:0;background:#070707}iframe{border:0;width:430px;height:410px}</style><iframe sandbox="allow-scripts"></iframe><script>
const frame=document.querySelector('iframe');window.calls=[];window.renderFixture=()=>{};
let status='expired';window.setApprovalStatus=value=>{status=value;};const snapshots=${JSON.stringify(snapshots).replace(/</g, "\\u003c")};
frame.onload=()=>frame.contentWindow.postMessage({type:'voiceos:init',capabilities:{invokeTool:true}},'*');frame.srcdoc=${JSON.stringify(html).replace(/</g, "\\u003c")};
addEventListener('message',e=>{const m=e.data;if(e.source!==frame.contentWindow||m.type!=='voiceos:invokeTool')return;calls.push(m);let result={ok:true};
if(m.name==='grokbot_card_files')result={ok:true,attachments:[]};
if(m.name==='grokbot_card_snapshot')result={ok:true,bots:${JSON.stringify(bots)},thread:snapshots[status]};
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
  await Bun.sleep(200);
  assert.equal(
    await ui("document.querySelector('.header .status').textContent"),
    "Idle",
  );
  assert.equal(
    await ui(
      "document.querySelector('[data-entry=approval] .request-title span').textContent",
    ),
    "Approval expired",
  );
  assert.equal(
    await ui(
      "document.querySelector('[data-entry=approval] .request-status').textContent",
    ),
    "Expired",
  );
  assert.equal(
    await ui(
      "document.querySelectorAll('[data-entry=approval] [data-open]').length",
    ),
    0,
  );
  assert.ok(
    await ui(
      "document.querySelector('[data-entry=approval]').textContent.includes('Approve PR 182')",
    ),
  );
  assert.equal(
    await ui("document.querySelectorAll('table thead th').length"),
    3,
  );
  assert.equal(
    await ui("document.querySelectorAll('table tbody tr').length"),
    5,
  );
  assert.ok(
    await ui(
      "[...document.querySelectorAll('table tbody tr')].every(r=>r.children.length===3)",
    ),
  );
  assert.equal(
    await ui("getComputedStyle(document.querySelector('td code')).color"),
    "rgb(255, 83, 103)",
  );
  assert.notEqual(
    await ui("getComputedStyle(document.querySelector('.hljs-keyword')).color"),
    await ui("getComputedStyle(document.querySelector('pre code')).color"),
  );
  for (const selector of [
    "h2",
    "ol",
    "ul",
    "blockquote",
    "del",
    "math",
    'a[href="https://example.com/docs"]',
  ])
    assert.ok(
      await ui(`!!document.querySelector(${JSON.stringify(selector)})`),
      selector,
    );
  assert.equal(
    await ui(
      "document.querySelectorAll('.bubble input[type=checkbox]:disabled').length",
    ),
    2,
  );
  await ui(
    "document.querySelector('#message').value='Keep this draft';document.querySelector('#message').dispatchEvent(new Event('input',{bubbles:true}))",
  );
  for (const width of [280, 430])
    for (const height of [160, 220, 410]) {
      await evaluate(
        `frame.style.width='${width}px';frame.style.height='${height}px'`,
      );
      await Bun.sleep(40);
      assert.ok(
        await ui(
          "(()=>{const c=document.querySelector('.composer').getBoundingClientRect();return c.bottom<=innerHeight+1&&c.left>=0&&c.right<=innerWidth+1&&document.documentElement.scrollWidth<=innerWidth})()",
        ),
        `bounded composer at ${width}x${height}`,
      );
      assert.ok(
        await ui(
          "(()=>{const t=document.querySelector('.table-scroll');t.scrollLeft=1000;return t.scrollWidth<=t.clientWidth||t.scrollLeft>0})()",
        ),
        "wide table scrolls within the bubble",
      );
    }
  await evaluate("frame.style.width='430px';frame.style.height='410px'");
  await ui(
    "document.querySelectorAll('.table-scroll').forEach(t=>t.scrollLeft=0);document.querySelector('[data-entry=rich-message]').scrollIntoView({block:'start'});",
  );
  await writeFile(
    join(dir, "rich-message.png"),
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await call("Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: 210,
    y: 180,
    deltaY: 10000,
    deltaX: 0,
  });
  await Bun.sleep(100);
  assert.ok(
    await ui(
      "(()=>{const s=document.querySelector('.messages');return s.scrollTop>0&&s.scrollHeight-s.scrollTop-s.clientHeight<2})()",
    ),
    "wheel scroll reaches the last card",
  );
  await writeFile(
    join(dir, "expired-approval.png"),
    Buffer.from(
      (await call("Page.captureScreenshot", { format: "png" })).data,
      "base64",
    ),
  );
  await ui("document.querySelector('.request-details summary').click()");
  assert.ok(
    await ui("document.querySelector('.request-details').open"),
    "full request expands locally",
  );
  for (const [status, title, attention] of [
    ["pending", "Approval required", true],
    ["expired", "Approval expired", false],
    ["approved", "Action allowed", false],
    ["denied", "Action denied", false],
  ] as const) {
    await evaluate(`setApprovalStatus('${status}')`);
    await ui("document.dispatchEvent(new Event('visibilitychange'))");
    for (let n = 0; n < 40; n++) {
      if (
        await ui(
          `document.querySelector('[data-entry=approval] .request-title span').textContent===${JSON.stringify(title)}`,
        )
      )
        break;
      await Bun.sleep(50);
    }
    assert.equal(
      await ui(
        "document.querySelector('[data-entry=approval] .request-title span').textContent",
      ),
      title,
    );
    assert.equal(
      await ui("document.querySelector('.header .status').textContent"),
      attention ? "Needs your attention" : "Idle",
    );
    assert.equal(
      await ui(
        "document.querySelectorAll('[data-entry=approval] [data-open]').length",
      ),
      attention ? 1 : 0,
    );
    assert.equal(
      await ui("document.querySelector('#message').value"),
      "Keep this draft",
    );
  }
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "native approval states and summary",
        "expired action disabled",
        "old connections do not demand attention",
        "GFM tables and code colors",
        "headings, nested lists, quotes, tasks, links and math",
        "six small viewports",
        "horizontal table and vertical message scrolling",
        "in-place state refresh preserves drafts",
        "full request expands locally",
      ],
    }),
  );
} finally {
  ws?.close();
  server.stop();
  child.kill();
  await child.exited;
  await rm(profile, { recursive: true, force: true });
  if (!process.env.RENDERING_CHECK_WORK_DIR)
    await rm(dir, { recursive: true, force: true });
}
