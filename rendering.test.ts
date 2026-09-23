import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.ts";
import { toThread, needsAttention, boundThread } from "./conversation.ts";
import type { TranscriptEntry } from "./client.ts";
import type { EntryState } from "./requestState.ts";

const request = (
  type: string,
  details: object,
  extra: Partial<TranscriptEntry> = {},
): TranscriptEntry => ({
  id: "request",
  kind: "send-message",
  message: {
    type,
    ...(type === "local-tool-permission"
      ? { ask: details }
      : { approval: details }),
  },
  ...extra,
});

describe("Grok request states", () => {
  test("the reported expired approval retains its summary and never asks for approval", () => {
    const items = toThread([
      request("auto-review-approval", {
        requestId: "ar-example",
        status: "expired",
        surface: "mcp",
        summary:
          "Approve PR 182 on voiceos-dictation as Jonah with user-Github",
        reason: "Review requested",
        command: "gh pr review 182 --approve",
      }),
    ]);
    expect(items[0]).toMatchObject({
      state: "expired",
      request: {
        title: "Approval expired",
        statusLabel: "Expired",
        attention: false,
        description:
          "Approve PR 182 on voiceos-dictation as Jonah with user-Github",
      },
    });
    expect(needsAttention(items)).toBe(false);
    expect(items[0].request?.details).toContainEqual([
      "Requested action",
      "gh pr review 182 --approve",
    ]);
  });
  for (const type of [
    "auto-review-approval",
    "local-tool-permission",
    "cookie-origin-approval",
    "virtual-card-approval",
  ]) {
    test.each([
      ["pending", "pending", true],
      ["approved", "resolved", false],
      ["always", "resolved", false],
      ["denied", "denied", false],
      ["expired", "expired", false],
      ["failed", "failed", false],
      ["cancelled", "cancelled", false],
      ["future_status", "unknown", false],
    ] as const)(
      `${type}: %s is mapped without inventing a pending request`,
      (status, state, attention) => {
        const items = toThread([
          request(type, {
            status,
            summary: "A request",
            title: "Request",
            target: "Target",
          }),
        ]);
        expect(items[0].state).toBe(state);
        expect(needsAttention(items)).toBe(attention);
      },
    );
  }
  test("credential, form, secret, and draft outcomes keep their actual meanings", () => {
    const cases: [TranscriptEntry, EntryState, string][] = [
      [
        {
          kind: "send-message",
          message: {
            type: "credential-request",
            credentialRequest: { label: "Sign in" },
          },
          credentialResolution: "denied",
        },
        "denied",
        "Denied",
      ],
      [
        {
          kind: "send-message",
          message: { type: "user-form", formRequest: { title: "Profile" } },
          formResolution: "submitted",
        },
        "resolved",
        "Submitted",
      ],
      [
        {
          kind: "send-message",
          message: { type: "user-form", formRequest: {} },
          formResolution: "fill_failed",
        },
        "failed",
        "Could not fill",
      ],
      [
        {
          kind: "send-message",
          message: {
            type: "secret-request",
            secretRequest: { label: "API key" },
          },
          secretProvided: true,
        },
        "resolved",
        "Provided",
      ],
      [
        {
          kind: "send-message",
          message: {
            type: "email-draft",
            draft: {
              subject: "Hello",
              body: "Message",
              to: ["someone@example.com"],
            },
          },
          draftDiscarded: true,
        },
        "dismissed",
        "Discarded",
      ],
      [
        {
          kind: "send-message",
          message: {
            type: "slack-draft",
            draft: { body: "Update", target: "#team" },
          },
          draftSent: true,
        },
        "resolved",
        "Sent",
      ],
    ];
    for (const [entry, state, statusLabel] of cases) {
      const item = toThread([entry])[0];
      expect(item.state).toBe(state);
      expect(item.request?.statusLabel).toBe(statusLabel);
      expect(needsAttention([item])).toBe(false);
    }
  });
  test("historic navigation cards cannot keep an idle bot in Needs your attention", () => {
    for (const type of [
      "connector",
      "connectors",
      "listener-connect",
      "scm-connect",
      "onepassword-connect",
      "team-access",
      "slack-connect",
      "cursor-agent",
      "bot-template-share",
    ]) {
      const item = toThread([
        {
          kind: "send-message",
          message: { type, reason: "Setup", body: "Details" },
        },
      ])[0];
      expect(item.request).toBeDefined();
      expect(needsAttention([item])).toBe(false);
    }
  });
  test("large expired requests do not regain an attention badge when deferred", () => {
    const items = boundThread(
      toThread([
        request("auto-review-approval", {
          status: "expired",
          summary: "Long description ".repeat(8000),
        }),
      ]),
      4000,
    );
    expect(items[0].deferred).toBeDefined();
    expect(items[0].deferred?.attention).toBe(false);
    expect(needsAttention(items)).toBe(false);
  });
  test("request details never copy secret form defaults or credential values", () => {
    const rows = toThread([
      {
        kind: "send-message",
        message: {
          type: "user-form",
          formRequest: {
            title: "Sign in",
            fields: [
              { label: "Password", type: "password", value: "SECRET_DEFAULT" },
            ],
          },
        },
      },
      request("auto-review-approval", {
        status: "expired",
        command:
          "run --token SECRET_TOKEN https://user:pass@example.com/?key=SECRET_QUERY",
      }),
    ]);
    const encoded = JSON.stringify(rows);
    expect(encoded).not.toContain("SECRET_");
    expect(encoded).not.toContain("user:pass");
    expect(rows[0].request?.details).toContainEqual([
      "Requested information",
      "Password",
    ]);
  });
});

describe("Grok Markdown rendering", () => {
  test("tables retain columns, alignment, escaped pipes and inline code", () => {
    const html = renderMarkdown(
      "| Message | Events | Meaning |\n| :--- | ---: | :---: |\n| `keyboard_tap_slow` | ~10k | Slow \\| tap telemetry |\n",
    );
    expect(html).toContain('<div class="table-scroll"');
    expect(html).toContain("<table>");
    expect(html.match(/<th(?:\s|>)/g)).toHaveLength(3);
    expect(html.match(/<td(?:\s|>)/g)).toHaveLength(3);
    expect(html).toContain("<code>keyboard_tap_slow</code>");
    expect(html).toContain('align="right"');
    expect(html).toContain("Slow | tap telemetry");
  });
  test("headings, nested lists, tasks, quotes, emphasis, rules, and references render", () => {
    const html = renderMarkdown(
      '## Heading\n\n3. First\n   - Nested **bold** and *italic*\n4. Next\n\n- [x] Done\n- [ ] Next\n\n> Quoted ~~old~~ text\n\n---\n\n[Reference][ref]\n\n[ref]: https://example.com/path "Example"',
    );
    for (const tag of [
      "<h2>",
      '<ol start="3">',
      "<ul>",
      "<strong>",
      "<em>",
      "<blockquote>",
      "<del>",
      "<hr",
    ])
      expect(html).toContain(tag);
    expect(html.match(/type="checkbox"/g)).toHaveLength(2);
    expect(html).toContain("disabled");
    expect(html).toContain('href="https://example.com/path"');
  });
  test("code is highlighted without formatting its literal Markdown or HTML", () => {
    const item = toThread([
      {
        kind: "message",
        content:
          '```typescript\nconst name = "hello"; // **literal**\nconst image = "![alt](file:///fake.png)";\n```',
      },
    ])[0];
    expect(item.media).toEqual([]);
    expect(item.html).toContain('class="hljs-keyword"');
    expect(item.html).toContain('class="hljs-string"');
    expect(item.html).toContain("**literal**");
    expect(item.html).toContain("file:///fake.png");
    expect(
      renderMarkdown("```not-a-language\n<div>safe & whole</div>\n```"),
    ).toContain("&lt;div&gt;safe &amp; whole&lt;/div&gt;");
  });
  test("reference images load as attachments without corrupting code samples", () => {
    const rows = toThread([
      {
        kind: "message",
        content:
          "![Figure][fig]\n\n[fig]: file:///home/figure.png\n\n`![not an image](file:///literal.png)`",
      },
    ]);
    expect(rows[0].media).toEqual([
      { source: "file:///home/figure.png", name: "Figure", kind: "image" },
    ]);
    expect(rows[0].html).toContain("![not an image](file:///literal.png)");
  });
  test("math renders offline as MathML and currency remains ordinary text", () => {
    const html = renderMarkdown(
      "Inline $x^2$ and a formula:\n\n$$\n\\frac{a}{b}\n$$\n\nCosts $5 and $10.",
    );
    expect(html).toContain("<math");
    expect(html).toContain("<mfrac>");
    expect(html).toContain("Costs $5 and $10.");
  });
  test("untrusted HTML, attributes, code and links never become executable content", () => {
    const html = renderMarkdown(
      '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[bad](javascript:alert%281%29) [data](data:text/html,bad)\n\n```html\n</code><script>alert(2)</script>\n```\n\n$\\href{javascript:alert(3)}{bad}$',
    );
    expect(html).not.toMatch(/<(script|img|iframe)\b/);
    expect(html).not.toMatch(/href="(?:javascript|data):/);
    expect(html).not.toMatch(/<[^>]+\sonerror="/);
    expect(html).toContain("&lt;script&gt;");
  });
});
