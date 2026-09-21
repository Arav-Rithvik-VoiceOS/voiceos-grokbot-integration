import type { TranscriptEntry } from "./client.ts";

export type EntryState =
  | "pending"
  | "resolved"
  | "dismissed"
  | "expired"
  | "denied"
  | "failed"
  | "cancelled"
  | "unknown";
export interface RequestCard {
  type: string;
  title: string;
  description: string;
  statusLabel?: string;
  attention: boolean;
  footer?: string;
  details?: [string, string][];
}
export const object = (v: unknown): Record<string, any> =>
  v && typeof v === "object" && !Array.isArray(v) ? v : {};
export const string = (v: unknown): string => (typeof v === "string" ? v : "");

const states: Record<string, EntryState> = {
  pending: "pending",
  retryable: "pending",
  approved: "resolved",
  always: "resolved",
  "allow-once": "resolved",
  connected: "resolved",
  submitted: "resolved",
  sent: "resolved",
  filled: "resolved",
  completed: "resolved",
  resolved: "resolved",
  provided: "resolved",
  dismissed: "dismissed",
  skipped: "dismissed",
  discarded: "dismissed",
  escalated: "dismissed",
  expired: "expired",
  stale: "expired",
  denied: "denied",
  rejected: "denied",
  never: "denied",
  "forbidden-by-team": "denied",
  failed: "failed",
  fill_failed: "failed",
  cancelled: "cancelled",
  canceled: "cancelled",
};
const labels: Record<string, string> = {
  approved: "Approved",
  always: "Always allowed",
  "allow-once": "Allowed once",
  connected: "Connected",
  submitted: "Submitted",
  sent: "Sent",
  filled: "Filled",
  provided: "Provided",
  dismissed: "Dismissed",
  skipped: "Skipped",
  discarded: "Discarded",
  escalated: "Escalated",
  expired: "Expired",
  stale: "Expired",
  denied: "Denied",
  rejected: "Declined",
  never: "Denied",
  "forbidden-by-team": "Blocked by team policy",
  failed: "Failed",
  fill_failed: "Could not fill",
  cancelled: "Cancelled",
  canceled: "Cancelled",
};
function rawState(e: TranscriptEntry): string | undefined {
  const m = object(e.message);
  // These statuses are authoritative, including after the approval session ends.
  const status =
    string(object(m.approval).status) ||
    string(object(m.ask).status) ||
    string(object(m.permission).status);
  if (status) return status;
  if (e.credentialResolution) return e.credentialResolution;
  if (e.formResolution) return e.formResolution;
  if (e.widgetDismissed) return "dismissed";
  if (e.widgetSkipped) return "skipped";
  if (e.draftDiscarded) return "discarded";
  if (e.draftSent) return "sent";
  if (e.secretProvided) return "provided";
  if (e.respondedValue != null) return "resolved";
  if (m.variant === "connected") return "connected";
}
export function entryState(e: TranscriptEntry): EntryState {
  const raw = rawState(e);
  return raw ? (states[raw] ?? "unknown") : "pending";
}

const titles: Record<string, string> = {
  "secret-request": "Credentials required",
  "credential-request": "Credential approval",
  "user-form": "Information required",
  "permission-request": "Permission required",
  "auto-review-approval": "Approval required",
  "local-tool-permission": "Local permission required",
  "cookie-origin-approval": "Browser sign-in required",
  "virtual-card-approval": "Payment approval",
  connector: "Connect account",
  connectors: "Connect accounts",
  "listener-connect": "Connect messaging",
  "scm-connect": "Connect source control",
  "onepassword-connect": "Connect 1Password",
  "team-access": "Team access required",
  "slack-connect": "Connect Slack",
  "email-draft": "Email draft",
  "slack-draft": "Slack draft",
  "cursor-agent": "Coding agent",
  "bot-template-share": "Shared bot",
};
// Connection prompts can remain in history after the account is connected. They
// are navigation cards, not evidence that the bot is currently blocked.
const passive = new Set([
  "connector",
  "connectors",
  "listener-connect",
  "scm-connect",
  "onepassword-connect",
  "team-access",
  "slack-connect",
  "cursor-agent",
  "bot-template-share",
]);
const redact = (text: string) =>
  text
    .replace(/https?:\/\/[^\s"'`]+/gi, (value) => {
      try {
        const u = new URL(value);
        u.username = "";
        u.password = "";
        u.search = "";
        u.hash = "";
        return u.href;
      } catch {
        return value;
      }
    })
    .replace(
      /((?:--)?(?:api[_-]?key|authorization|credential|password|secret|signature|token)\s*(?:=|:|\s)\s*)(?:"[^"]*"|'[^']*'|[^\s]+)/gi,
      "$1…",
    )
    .replace(/\bBearer\s+[^\s"'`]+/gi, "Bearer …")
    .replace(
      /\b(?:sk[-_]|gh[pousr]_|xox[baprs]-|AIza)[A-Za-z0-9+/_=-]+/gi,
      "…",
    );

export function requestCard(e: TranscriptEntry): RequestCard {
  const m = object(e.message),
    type = string(m.type),
    state = entryState(e);
  const d = object(
    m.secretRequest ??
      m.credentialRequest ??
      m.formRequest ??
      m.permission ??
      m.approval ??
      m.draft ??
      m.ask,
  );
  const raw = rawState(e);
  const card: RequestCard = {
    type,
    title:
      string(d.label ?? d.title ?? d.subject ?? m.title) ||
      titles[type] ||
      "Message from Grok Bot",
    description:
      string(
        d.summary ?? d.description ?? d.body ?? d.target ?? m.reason ?? m.body,
      ) ||
      [
        m.connector,
        m.provider,
        m.platform,
        ...(Array.isArray(m.connectors) ? m.connectors : []),
      ]
        .filter((v) => typeof v === "string")
        .join(" · "),
    statusLabel:
      raw && raw !== "pending" && raw !== "retryable"
        ? (labels[raw] ??
          (state === "resolved" ? "Completed" : "Status unavailable"))
        : undefined,
    attention: state === "pending" && !!titles[type] && !passive.has(type),
  };
  if (type === "auto-review-approval") {
    card.title =
      state === "expired"
        ? "Approval expired"
        : state === "denied"
          ? "Action denied"
          : state === "resolved"
            ? "Action allowed"
            : state === "failed"
              ? "Approval failed"
              : state === "cancelled"
                ? "Approval cancelled"
                : state === "unknown"
                  ? "Approval status unavailable"
                  : "Approval required";
    card.footer =
      state !== "pending"
        ? "You can manage Auto-review in Settings"
        : undefined;
  }
  if (type === "local-tool-permission" && state === "expired")
    card.title = "Permission request expired";
  if (type === "virtual-card-approval" && state === "expired")
    card.footer = "This request has expired. No charge was made.";
  if (type === "virtual-card-approval" && state === "denied")
    card.footer = "This card was declined. No charge was made.";
  if (state === "failed" && typeof d.failureReason === "string")
    card.footer = d.failureReason;
  const details: [string, string][] = [];
  const add = (label: string, value: unknown) => {
    if (typeof value === "string" && value.trim() && value !== card.description)
      details.push([label, value]);
  };
  add("Reason", d.reason);
  if (typeof d.command === "string") add("Requested action", redact(d.command));
  if (type === "email-draft" || type === "slack-draft") {
    add("From", d.from);
    add("To", Array.isArray(d.to) ? d.to.join(", ") : (d.to ?? d.target));
    add("Cc", Array.isArray(d.cc) ? d.cc.join(", ") : d.cc);
    add("Workspace", d.workspace);
  }
  if (type === "user-form" && Array.isArray(d.fields)) {
    // Show field labels, never secret defaults or stored credentials.
    const names = d.fields
      .map((f: unknown) => string(object(f).label))
      .filter(Boolean);
    if (names.length) details.push(["Requested information", names.join("\n")]);
  }
  if (type === "bot-template-share") card.title = string(m.name) || card.title;
  if (details.length) card.details = details;
  return card;
}
