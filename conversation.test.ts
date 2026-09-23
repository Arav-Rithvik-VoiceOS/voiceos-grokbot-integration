import { describe, expect, test } from "bun:test";
import {
  toThread,
  needsAttention,
  choiceResponse,
  entryMedia,
  boundThread,
  serializeThreadItem,
  threadItemVersion,
} from "./conversation.ts";
import {
  conversationTransport,
  conversationEntry,
  performConversationAction,
} from "./conversationService.ts";
import { threadCard, showCard, glanceChars } from "./cards.ts";
import { LIVE_CHAT_JS } from "./assets.generated.ts";
import type { TranscriptEntry } from "./client.ts";

const question: TranscriptEntry = {
  kind: "send-message",
  id: "question",
  message: {
    type: "widget",
    widget: {
      prompt: "Ship this C, or tweak further?",
      options: [
        { label: "Ship this", value: "Ship C v3 for draft 001" },
        { label: "Tweak more", value: "Tweak C further" },
      ],
    },
  },
};
const image: TranscriptEntry = {
  kind: "send-message",
  id: "image",
  message: {
    type: "text",
    content: "Here’s C without the logo shadow.",
    images: [
      {
        url: "file:///home/box/agent-data/agents/picasso/attachments/c.png",
        alt: "Concept C",
      },
    ],
  },
};

describe("Grok conversation event parity", () => {
  test("retains the image and exact choice values in the reported Picasso regression", () => {
    const items = toThread([image, question]);
    expect(items[0].media).toEqual([
      {
        source: "file:///home/box/agent-data/agents/picasso/attachments/c.png",
        name: "Concept C",
        kind: "image",
      },
    ]);
    expect(items[1].choice?.options[0]).toMatchObject({
      label: "Ship this",
      value: "Ship C v3 for draft 001",
    });
    expect(needsAttention(items)).toBe(true);
    expect(choiceResponse(question, ["Ship C v3 for draft 001"])).toBe(
      "Ship C v3 for draft 001",
    );
  });
  test("shows outgoing bot communication as a Messaged row, not a duplicate bubble", () => {
    expect(
      toThread([
        {
          kind: "message",
          id: "outgoing",
          content: "Internal handoff",
          toAgent: { id: "seo", name: "SEO Master" },
        },
      ])[0],
    ).toMatchObject({ sys: "Messaged", bot: "seo", sender: "SEO Master" });
    expect(
      toThread([
        {
          kind: "message",
          content: "Internal handoff",
          toAgent: { id: "seo" },
        },
      ])[0].text,
    ).toBeUndefined();
  });
  test("renders image-only messages, user uploads, files, notices, and unknown request types", () => {
    const rows = toThread([
      {
        kind: "send-message",
        message: {
          type: "attachment",
          url: "/home/report.pdf",
          file_name: "Report.pdf",
        },
      },
      {
        kind: "user-attachment",
        file_path: "/home/photo.png",
        file_name: "Photo.png",
      },
      { kind: "notice", text: "Connection restored" },
      { kind: "send-message", message: { type: "future-approval" } },
    ]);
    expect(rows).toHaveLength(4);
    expect(rows[0].media?.[0].kind).toBe("file");
    expect(rows[1].from).toBe("me");
    expect(rows[2].sys).toBe("Connection restored");
    expect(rows[3].request?.title).toBe("Message from Grok Bot");
    expect(rows[3].request?.attention).toBe(false);
  });
  test("auth, forms, connection, and approval requests remain visible with resolved states", () => {
    const rows = toThread([
      {
        kind: "send-message",
        id: "key",
        message: {
          type: "secret-request",
          secretRequest: {
            label: "OpenAI API key",
            description: "Used for images",
          },
        },
        secretProvided: true,
      },
      {
        kind: "send-message",
        message: {
          type: "user-form",
          formRequest: { title: "Choose account" },
        },
      },
      {
        kind: "send-message",
        message: {
          type: "connector",
          connector: "Google",
          variant: "connected",
        },
      },
      {
        kind: "send-message",
        message: {
          type: "permission-request",
          permission: { title: "Approve command" },
        },
      },
    ]);
    expect(rows.map((r) => r.state)).toEqual([
      "resolved",
      "pending",
      "resolved",
      "pending",
    ]);
    expect(rows.map((r) => r.request?.title)).toEqual([
      "OpenAI API key",
      "Choose account",
      "Connect account",
      "Approve command",
    ]);
  });
  test("rejects stale, invented, and unsupported custom answers", () => {
    expect(() =>
      choiceResponse({ ...question, respondedValue: "done" }, [
        "Tweak C further",
      ]),
    ).toThrow("already");
    expect(() =>
      choiceResponse({ ...question, widgetSkipped: true }, ["Tweak C further"]),
    ).toThrow("already");
    expect(() => choiceResponse(question, ["Invented answer"])).toThrow(
      "no longer",
    );
    expect(() => choiceResponse(question, [], "Custom")).toThrow("custom");
    expect(() =>
      choiceResponse(question, ["Ship C v3 for draft 001", "Tweak C further"]),
    ).toThrow("one answer");
  });
  test("multi-select follows option order and supports permitted custom text", () => {
    const multi = {
      ...question,
      message: {
        ...(question.message as object),
        widget: {
          ...(question.message as any).widget,
          multiSelect: true,
          allowCustom: true,
        },
      },
    };
    expect(
      choiceResponse(
        multi,
        ["Tweak C further", "Ship C v3 for draft 001"],
        "And export",
      ),
    ).toBe("Ship C v3 for draft 001\nTweak C further\nAnd export");
  });
  test("normalizes markdown images without losing other content", () => {
    const e = {
      kind: "message",
      content: "Here ![test](file:///home/test.png) it is",
    };
    expect(entryMedia(e)).toHaveLength(1);
    expect(toThread([e])[0].text).toBe(e.content);
    expect(toThread([e])[0].html).toContain("Here  it is");
  });
  test("bounds large histories while preserving entries for pagination", () => {
    const items = toThread(
      Array.from({ length: 40 }, (_, i) => ({
        kind: "message",
        id: `large-${i}`,
        content: '"\\\n'.repeat(10000),
      })),
    );
    const bounded = boundThread(items, 40000);
    expect(bounded.map((item) => item.id)).toEqual(
      items.map((item) => item.id),
    );
    expect(JSON.stringify(bounded).length).toBeLessThan(40000);
    expect(bounded.every((item) => !!item.deferred && !item.request)).toBe(
      true,
    );
    expect(needsAttention(bounded)).toBe(false);
  });
  test("multi-select normalizes line breaks like the native widget", () => {
    const entry = {
      ...question,
      message: {
        type: "widget",
        widget: {
          prompt: "Choose",
          multiSelect: true,
          allowCustom: true,
          options: [{ label: "A", value: " First\n answer " }],
        },
      },
    };
    expect(choiceResponse(entry, [" First\n answer "], "Custom\n text")).toBe(
      "First answer\nCustom text",
    );
  });
  test("untrusted transcript strings cannot end the payload script", () => {
    const html = threadCard({ id: "picasso", name: "Picasso" }, [
      { kind: "message", content: '</script><img src=x onerror="alert(1)">' },
    ])._voiceos_glance.blocks[0].html;
    expect(html).not.toContain("</script><img src=x");
    expect(html).toContain("\\u003c/script>");
    expect(
      glanceChars(
        threadCard({ id: "picasso", name: "Picasso" }, [image, question]),
      ),
    ).toBeLessThan(96000);
    expect(
      glanceChars(
        showCard(
          Array.from({ length: 30 }, (_, i) => ({
            id: String(i),
            name: "Bot " + i,
          })),
        ),
      ),
    ).toBeLessThan(96000);
  });
});

describe("card responses", () => {
  function setup(entry = question, accepted = true) {
    const calls: unknown[] = [];
    return {
      calls,
      transport: {
        ...conversationTransport,
        listAgents: async () => [{ id: "picasso", name: "Picasso" }],
        transcriptTail: async () => ({ entries: [entry] }),
        respondToWidget: async (...args: [string, string, string]) => {
          calls.push(args);
          return { accepted };
        },
        dismissWidget: async (...args: [string, string]) => {
          calls.push(args);
          return { accepted };
        },
        openGrokBotApp: () => {
          calls.push("open");
        },
      },
    };
  }
  test("submits the gateway response once, and never sends an ordinary prompt", async () => {
    const f = setup();
    expect(
      await performConversationAction(
        {
          bot: "picasso",
          entryId: "question",
          action: "answer",
          values: ["Tweak C further"],
        },
        f.transport,
      ),
    ).toEqual({ ok: true, state: "resolved" });
    expect(f.calls).toEqual([["picasso", "question", "Tweak C further"]]);
  });
  test("rechecks live state before dismissing or answering", async () => {
    const f = setup({
      ...question,
      respondedValue: "Already answered in Grok",
    });
    await expect(
      performConversationAction(
        { bot: "picasso", entryId: "question", action: "dismiss" },
        f.transport,
      ),
    ).rejects.toThrow("already");
    expect(f.calls).toHaveLength(0);
  });
  test("upstream rejection is not reported as success", async () => {
    const f = setup(question, false);
    await expect(
      performConversationAction(
        {
          bot: "picasso",
          entryId: "question",
          action: "answer",
          values: ["Tweak C further"],
        },
        f.transport,
      ),
    ).rejects.toThrow("did not accept");
  });
  test("native auth can open even when the session has expired", async () => {
    const f = setup();
    f.transport.listAgents = async () => {
      throw Error("Session expired");
    };
    expect(
      await performConversationAction(
        { bot: "picasso", action: "open" },
        f.transport,
      ),
    ).toEqual({ ok: true, opened: true });
    expect(f.calls).toEqual(["open"]);
  });
});

test("live conversation refreshes itself: no manual reload control", () => {
  const html = threadCard({ id: "a", name: "Picasso" }, [])._voiceos_glance
    .blocks[0].html;
  // The live chat rides inside the thread card's own script and polls
  // grokbot_card_snapshot; the handoff UI gains no reload button.
  expect(html).toContain(LIVE_CHAT_JS);
  expect(html).not.toContain("data-refresh");
  expect(html).not.toContain("Refresh manually");
});

test("ordinary long replies remain whole alongside many short messages", () => {
  const text =
    "How Grok Bot payments work today\n" +
    "A full explanation with every detail.\n".repeat(70) +
    "The final paragraph.";
  const items = toThread(
    Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      kind: "message",
      content: i === 39 ? text : "Short reply",
    })),
  );
  const bounded = boundThread(items, 40_000);
  expect(bounded[39].text).toBe(text);
  expect(bounded[39].deferred).toBeUndefined();
  expect(bounded[39].request).toBeUndefined();
});

test("huge entries load completely in bounded, lossless chunks", async () => {
  const entry: TranscriptEntry = {
    id: "huge",
    kind: "message",
    content: '"\\\n\u0000😀'.repeat(18000) + "END OF COMPLETE MESSAGE",
  };
  const item = toThread([entry])[0],
    serialized = serializeThreadItem(item),
    stub = boundThread([item], 40000)[0];
  expect(stub.deferred?.version).toBe(threadItemVersion(serialized));
  const transport = {
    ...conversationTransport,
    listAgents: async () => [{ id: "sam", name: "Sam" }],
    transcriptTail: async () => ({ entries: [entry] }),
  };
  let offset = 0,
    joined = "",
    count = 0;
  do {
    const part = await conversationEntry(
      "sam",
      "huge",
      offset,
      stub.deferred!.version,
      transport,
    );
    expect(part.offset).toBe(offset);
    expect(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(part) }],
      }).length,
    ).toBeLessThan(131072);
    joined += part.chunk;
    count++;
    if (part.nextOffset === null) break;
    offset = part.nextOffset;
  } while (count < 100);
  expect(count).toBeGreaterThan(1);
  expect(joined).toBe(serialized);
  expect(JSON.parse(joined).text).toBe(entry.content);
}, 15_000);

test("large structured questions retain every choice and live state after automatic loading", async () => {
  const entry: TranscriptEntry = {
    id: "question-big",
    kind: "send-message",
    message: {
      type: "widget",
      widget: {
        prompt: "Pick a plan",
        options: [
          { label: "Detailed plan", value: "Full exact value ".repeat(7000) },
        ],
      },
    },
  };
  const item = toThread([entry])[0],
    stub = boundThread([item], 40000)[0];
  expect(stub.deferred?.attention).toBe(true);
  const transport = {
    ...conversationTransport,
    listAgents: async () => [{ id: "sam", name: "Sam" }],
    transcriptTail: async () => ({ entries: [entry] }),
  };
  const first = await conversationEntry(
    "sam",
    entry.id!,
    0,
    undefined,
    transport,
  );
  const changed = await conversationEntry(
    "sam",
    entry.id!,
    first.nextOffset!,
    "obsolete-version",
    transport,
  );
  expect(changed.offset).toBe(0);
  expect(changed.chunk).toBe(first.chunk);
  expect(item.choice?.options[0].value).toEndWith("Full exact value ");
  expect(stub.request).toBeUndefined();
});

test("entry readers reject missing bots, unknown entries, and invalid offsets", async () => {
  const transport = {
    ...conversationTransport,
    listAgents: async () => [{ id: "sam", name: "Sam" }],
    transcriptTail: async () => ({
      entries: [{ id: "entry", kind: "message", content: "Hello" }],
    }),
  };
  await expect(
    conversationEntry("other", "entry", 0, undefined, transport),
  ).rejects.toThrow("no longer available");
  await expect(
    conversationEntry("sam", "unknown", 0, undefined, transport),
  ).rejects.toThrow("no longer available");
  await expect(
    conversationEntry("sam", "entry", -1, undefined, transport),
  ).rejects.toThrow("offset");
});

test("script escaping cannot overflow the initial card for long messages", () => {
  const text = "<".repeat(15000) + "LAST LINE";
  const card = threadCard({ id: "sam", name: "Sam" }, [
    { id: "long", kind: "message", content: text },
  ]);
  expect(glanceChars(card)).toBeLessThan(96000);
  expect(card._voiceos_glance.blocks[0].html).not.toContain(
    "View full message",
  );
});
