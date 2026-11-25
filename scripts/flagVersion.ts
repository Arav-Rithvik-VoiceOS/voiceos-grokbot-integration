// The client version the app uses comes from the PostHog flag
// "grokbot-client-version" ({ darwin, win32 }). The health check must test
// that version, or a rejected flag version goes unnoticed (VOS-1672).
export const GROK_BOT_CLIENT_VERSION_FLAG = "grokbot-client-version";
const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;

/** The flag's version for this platform, or undefined when it has none. */
export async function flagClientVersion(options: {
  apiKey: string;
  host?: string;
  platform: string;
  fetchImpl?: typeof fetch;
}): Promise<string | undefined> {
  const response = await (options.fetchImpl ?? fetch)(
    `${(options.host ?? "https://us.i.posthog.com").replace(/\/$/, "")}/flags?v=2`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: options.apiKey, distinct_id: "grokbot-health-check" }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`PostHog flags answered HTTP ${response.status}.`);
  const body = (await response.json()) as {
    flags?: Record<string, { enabled?: boolean; metadata?: { payload?: unknown } }>;
  };
  const flag = body.flags?.[GROK_BOT_CLIENT_VERSION_FLAG];
  if (!flag?.enabled) return undefined;
  let payload = flag.metadata?.payload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      return undefined;
    }
  }
  const value = payload && typeof payload === "object" ? (payload as Record<string, unknown>)[options.platform] : undefined;
  return typeof value === "string" && VERSION.test(value) ? value : undefined;
}
