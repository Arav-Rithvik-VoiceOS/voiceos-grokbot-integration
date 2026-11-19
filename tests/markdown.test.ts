import { describe, expect, test } from "bun:test";
import { markdownPreview, renderMarkdown } from "../markdown.ts";

describe("a reply that is only a number and a period", () => {
  test("renders as plain text, not an empty numbered list", () => {
    for (const reply of ["4.", "10.", "3)"]) {
      const html = renderMarkdown(reply);
      expect(html).not.toContain("<ol");
      expect(html).not.toContain("<li");
      expect(html).toContain(reply);
    }
  });

  test("the roster preview keeps the number", () => {
    expect(markdownPreview("10.")).toBe("10.");
  });

  test("a real numbered list still renders as a list", () => {
    const html = renderMarkdown("1. First\n2. Second");
    expect(html).toContain("<ol");
    expect(html).toContain("<li>First</li>");
  });
});
