import { describe, expect, test } from "bun:test";
import { avatarFor, defaultAvatar } from "./avatar.ts";
import { avatarThumbnail } from "./avatarImage.ts";
import { avatarShapes } from "./avatarShapes.generated.ts";
import {
  glanceChars,
  groupThreadCard,
  showCard,
  threadCard,
  toBot,
  toGroup,
} from "./cards.ts";
import {
  conversationSnapshot,
  conversationTransport,
} from "./conversationService.ts";
import type { Agent } from "./client.ts";

const terry: Agent = {
  id: "c21ab4dd-fde0-46bc-95ff-90c164cef98f",
  name: "Terry",
  avatarColor: null,
  avatarShape: null,
};
const sol: Agent = {
  id: "sol",
  name: "Sol",
  avatarColor: "black",
  avatarShape: "cloud",
};
const group: Agent = {
  id: "group",
  name: "Blog Generation",
  isGroup: true,
  memberIds: [terry.id, sol.id],
};
const roster = [terry, sol, group];
const payload = (card: ReturnType<typeof showCard>) =>
  JSON.parse(
    card._voiceos_glance.blocks[0].html.match(
      /id="payload">(.*?)<\/script>/s,
    )![1],
  );

describe("native Grok roster identities", () => {
  test("unset fields use Grok's ID defaults, including Terry's pink pebble", () => {
    expect(defaultAvatar(terry.id)).toEqual({
      color: "magenta",
      shape: "pebble",
    });
    expect(avatarFor(terry)).toMatchObject({
      color: "#E02A88",
      shape: "pebble",
    });
    expect(avatarFor({ ...terry, avatarColor: "gray" }).color).toBe("#777777");
    expect(avatarFor({ ...terry, avatarShape: "hex" }).shape).toBe("hex");
  });
  test("black avatars are white in dark mode, and template shapes stay distinct", () => {
    expect(avatarFor(sol)).toMatchObject({ color: "#FFFFFF", shape: "cloud" });
    for (const shape of Object.keys(avatarShapes))
      expect(avatarFor({ ...sol, avatarShape: shape }).shape).toBe(shape);
  });
  test("custom pictures are preserved without permitting remote URLs or markup", async () => {
    const picture = "data:image/png;base64,aGVsbG8=";
    expect(avatarFor({ ...terry, avatarDataUrl: picture }).picture).toBe(
      picture,
    );
    expect(await avatarThumbnail(picture)).toBe(picture);
    for (const value of [
      "https://example.com/avatar.png",
      'data:image/svg+xml,<svg onload="alert(1)">',
      'data:image/png;base64,a" onerror="alert(1)',
    ]) {
      expect(
        avatarFor({ ...terry, avatarDataUrl: value }).picture,
      ).toBeUndefined();
      expect(await avatarThumbnail(value)).toBeUndefined();
    }
  });
  test("working, unread, and waiting are independent native flags", () => {
    expect(
      toBot({
        ...terry,
        isRunning: true,
        hasUnread: true,
        awaitingUserResponse: null,
      }),
    ).toMatchObject({ working: true, unread: true, attention: false });
    expect(
      toBot({
        ...terry,
        isRunning: true,
        awaitingUserResponse: { kind: "widget" },
      }),
    ).toMatchObject({ working: false, attention: true });
    expect(
      toBot({
        ...terry,
        isRunning: false,
        isRunningTurn: true,
        awaitingUserResponse: null,
      }),
    ).toMatchObject({ working: false, status: "idle", attention: false });
    expect(toBot({ ...terry, isComposingMessage: true })).toMatchObject({
      working: true,
      status: "thinking",
    });
    expect(toBot(terry)).toMatchObject({
      working: false,
      unread: false,
      status: "idle",
    });
    expect(toGroup({ ...group, isRunning: true })).toMatchObject({
      working: false,
      isGroup: true,
      members: [terry.id, sol.id],
    });
  });
  test("group identity and history survive every conversation entry point", () => {
    const entry = { id: "g1", kind: "message", content: "Group history" };
    const direct = payload(threadCard(group, [entry], "", roster));
    expect(direct.args.group).toBe(group.id);
    expect(direct.data.groups[0]).toMatchObject({
      id: group.id,
      isGroup: true,
      members: group.memberIds,
    });
    expect(direct.data.bots).toHaveLength(2);
    expect(direct.data.thread[0].text).toBe("Group history");
    const existing = payload(
      groupThreadCard(
        roster,
        { id: group.id, name: group.name, members: group.memberIds! },
        [entry],
      ),
    );
    expect(existing.data.thread[0].text).toBe("Group history");
    expect(payload(showCard(roster)).data.groups[0].name).toBe(group.name);
  });
  test("roster refresh never reads a phantom conversation; groups load their own history", async () => {
    const reads: string[] = [];
    const transport = {
      ...conversationTransport,
      listAgents: async () => roster,
      transcriptTail: async (id: string) => {
        reads.push(id);
        return {
          entries: [{ id: "g1", kind: "message", content: "Group history" }],
          nextBeforeSeq: 3,
        };
      },
    };
    expect(
      (await conversationSnapshot(undefined, undefined, transport)).agents,
    ).toEqual(roster);
    expect(reads).toEqual([]);
    expect(
      (await conversationSnapshot(group.id, undefined, transport)).thread[0]
        .text,
    ).toBe("Group history");
    expect(reads).toEqual([group.id]);
  });
  test("a full shape roster still fits the Notch transport budget", () => {
    const all = Object.keys(avatarShapes).map((shape, i) => ({
      id: String(i),
      name: shape,
      avatarShape: shape,
    }));
    expect(glanceChars(showCard([...all, group]))).toBeLessThan(96_000);
  });
});
