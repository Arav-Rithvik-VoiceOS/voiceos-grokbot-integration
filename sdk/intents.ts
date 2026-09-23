/** App-declared short commands. Kept dependency-free for the server contract mirror. */
export interface IntentSlot {
  type: "string" | "number" | "enum";
  values?: string[];
  /** Resolve an enum from this tool's live MCP metadata (or input-schema enum). */
  valuesFrom?: "tool";
  examples?: string[];
  required?: boolean;
}
export interface IntentDefinition {
  name: string;
  tool: string;
  description: string;
  utterances: Record<string, string[]>;
  slots?: Record<string, IntentSlot>;
  fixedArgs?: Record<string, unknown>;
  /** An acknowledgement, not a claim that execution already succeeded. */
  response: Record<string, string>;
  /** Legacy similarity setting; ignored by the LLM selector. */
  minConfidence?: number;
}

/** MCP tools/list _meta key: { [slotName]: string[] }. Never put secrets here. */
export const INTENT_SLOT_VALUES_META_KEY = "voiceos/intent-slot-values";
/** Optional read-only refresh hint sent at Agent trigger-down. No reply is awaited. */
export const INTENT_REFRESH_NOTIFICATION_METHOD =
  "notifications/voiceos/refresh_intent_values";

const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
export const hasOwn = (value: object, key: PropertyKey): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);
const identifier = /^[a-z][a-z0-9_]{0,63}$/;
const text = (v: unknown, max = 500): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;
const safeKey = (key: string) =>
  !["__proto__", "prototype", "constructor"].includes(key);
export function intentLanguage(language: string): string {
  try {
    return Intl.getCanonicalLocales(language)[0].toLowerCase();
  } catch {
    return "";
  }
}

/** Runtime checks shared by install, author CLI and server admission. */
export function intentErrors(
  input: unknown,
  tools: readonly { name: string; inputSchema: Record<string, unknown> }[],
): string[] {
  if (input === undefined) return [];
  if (!Array.isArray(input) || input.length > 30)
    return ["intents: expected at most 30 intents"];
  const errors: string[] = [];
  const names = new Set<string>();
  for (const [index, value] of input.entries()) {
    const p = `intents.${index}`;
    if (!object(value)) {
      errors.push(`${p}: expected object`);
      continue;
    }
    if (
      !text(value.name, 64) ||
      !identifier.test(value.name) ||
      names.has(value.name)
    )
      errors.push(`${p}.name: expected unique snake_case name`);
    names.add(String(value.name));
    if (!text(value.description, 1000))
      errors.push(`${p}.description: expected 1–1000 characters`);
    const tool = tools.find((t) => t.name === value.tool);
    if (!tool) errors.push(`${p}.tool: must name a declared tool`);
    const properties = object(tool?.inputSchema.properties)
      ? tool.inputSchema.properties
      : {};
    const slots = object(value.slots) ? value.slots : {};
    const fixed = object(value.fixedArgs) ? value.fixedArgs : {};
    if (value.slots !== undefined && !object(value.slots))
      errors.push(`${p}.slots: expected object`);
    if (value.fixedArgs !== undefined && !object(value.fixedArgs))
      errors.push(`${p}.fixedArgs: expected object`);
    for (const key of new Set([...Object.keys(slots), ...Object.keys(fixed)])) {
      if (
        !safeKey(key) ||
        !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key) ||
        !hasOwn(properties, key)
      )
        errors.push(
          `${p}.${key}: slot/fixed argument must be a tool input property`,
        );
    }
    for (const [key, slot] of Object.entries(slots)) {
      if (
        !object(slot) ||
        !["string", "number", "enum"].includes(String(slot.type))
      ) {
        errors.push(`${p}.slots.${key}: invalid type`);
        continue;
      }
      if (slot.required !== undefined && typeof slot.required !== "boolean")
        errors.push(`${p}.slots.${key}.required: expected boolean`);
      for (const field of ["values", "examples"] as const) {
        if (
          slot[field] !== undefined &&
          (!Array.isArray(slot[field]) ||
            slot[field].length > 30 ||
            !slot[field].every((v) => text(v, 200)))
        )
          errors.push(
            `${p}.slots.${key}.${field}: expected at most 30 nonempty strings`,
          );
      }
      if (
        slot.type === "enum" &&
        slot.valuesFrom !== "tool" &&
        (!Array.isArray(slot.values) || !slot.values.length)
      )
        errors.push(`${p}.slots.${key}: enum requires values`);
      if (
        slot.valuesFrom !== undefined &&
        (slot.valuesFrom !== "tool" ||
          slot.type !== "enum" ||
          slot.values !== undefined)
      )
        errors.push(
          `${p}.slots.${key}: valuesFrom requires an enum without static values`,
        );
      const prop = properties[key];
      if (
        object(prop) &&
        typeof prop.type === "string" &&
        prop.type !== (slot.type === "enum" ? "string" : slot.type) &&
        !(prop.type === "integer" && slot.type === "number")
      )
        errors.push(`${p}.slots.${key}: type differs from tool schema`);
    }
    for (const key of Array.isArray(tool?.inputSchema.required)
      ? tool.inputSchema.required
      : []) {
      if (
        typeof key === "string" &&
        !hasOwn(fixed, key) &&
        !(object(slots[key]) && slots[key].required === true)
      )
        errors.push(
          `${p}.${key}: required tool input must be fixed or a required slot`,
        );
    }
    const known = new Set([...Object.keys(slots), ...Object.keys(fixed)]);
    for (const field of ["utterances", "response"] as const) {
      const langs = value[field];
      if (
        !object(langs) ||
        !Object.keys(langs).length ||
        Object.keys(langs).length > 20
      ) {
        errors.push(`${p}.${field}: expected 1–20 languages`);
        continue;
      }
      for (const [lang, content] of Object.entries(langs)) {
        if (!intentLanguage(lang))
          errors.push(`${p}.${field}.${lang}: invalid BCP-47 language`);
        const strings = field === "response" ? [content] : content;
        if (
          !Array.isArray(strings) ||
          !strings.length ||
          strings.length > 20 ||
          !strings.every((s) => text(s))
        ) {
          errors.push(
            `${p}.${field}.${lang}: expected nonempty text (max 20 examples, 500 chars each)`,
          );
          continue;
        }
        for (const s of strings as string[]) {
          const placeholders = [...s.matchAll(/\{([^{}]+)\}/g)].map(
            (m) => m[1],
          );
          if (placeholders.some((k) => !known.has(k)))
            errors.push(`${p}.${field}.${lang}: unknown placeholder`);
          if (field === "utterances")
            for (const [key, slot] of Object.entries(slots)) {
              if (
                object(slot) &&
                slot.required &&
                !hasOwn(fixed, key) &&
                !placeholders.includes(key)
              )
                errors.push(
                  `${p}.utterances.${lang}: missing required {${key}}`,
                );
            }
        }
      }
    }
    if (
      value.minConfidence !== undefined &&
      (typeof value.minConfidence !== "number" ||
        !Number.isFinite(value.minConfidence) ||
        value.minConfidence < 0 ||
        value.minConfidence > 1)
    )
      errors.push(`${p}.minConfidence: expected 0–1`);
  }
  return errors;
}

/** Resolve locally cached choices; missing/invalid lists omit the entire intent. */
export function resolveIntentSlots(
  intent: IntentDefinition,
  schema: Record<string, unknown>,
  toolValues?: unknown,
): IntentDefinition | undefined {
  const slots: Record<string, IntentSlot> = {};
  const properties = object(schema.properties) ? schema.properties : {};
  for (const [key, slot] of Object.entries(intent.slots ?? {})) {
    const property = properties[key];
    const schemaValues = object(property) ? property.enum : undefined;
    const dynamic = slot.valuesFrom === "tool";
    let values: unknown = dynamic
      ? object(toolValues) && hasOwn(toolValues, key)
        ? toolValues[key]
        : schemaValues
      : slot.type === "enum"
        ? slot.values
        : slot.type === "string"
          ? schemaValues
          : undefined;
    if (dynamic || values !== undefined) {
      if (
        !Array.isArray(values) ||
        !values.length ||
        values.length > 30 ||
        !values.every((value) => text(value, 200))
      )
        return undefined;
      // Both the app's intent restrictions and the tool schema must allow it.
      if (Array.isArray(schemaValues))
        values = values.filter((value) => schemaValues.includes(value));
      if (!(values as string[]).length) return undefined;
      const { valuesFrom: _source, examples: _examples, ...rest } = slot;
      slots[key] = {
        ...rest,
        type: "enum",
        values: [...new Set(values as string[])],
      };
    } else slots[key] = slot;
  }
  return { ...intent, ...(intent.slots ? { slots } : {}) };
}

export function intentResponse(
  intent: IntentDefinition,
  language: string,
  args: Record<string, unknown>,
): string | undefined {
  const normalized = intentLanguage(language);
  const entries = Object.entries(intent.response);
  const template =
    entries.find(([l]) => intentLanguage(l) === normalized)?.[1] ??
    entries.find(
      ([l]) => intentLanguage(l).split("-")[0] === normalized.split("-")[0],
    )?.[1];
  if (!template) return undefined;
  let missing = false;
  const result = template.replace(/\{([^{}]+)\}/g, (_, key: string) => {
    if (!hasOwn(args, key)) {
      missing = true;
      return "";
    }
    return String(args[key]);
  });
  return missing ? undefined : result;
}

/** Deterministic template matching for the author dry-run only. */
export function matchIntentTemplate(
  intent: IntentDefinition,
  phrase: string,
): Record<string, unknown> | null {
  if (
    Object.entries(intent.slots ?? {}).some(
      ([key, slot]) =>
        slot.type !== "enum" && !hasOwn(intent.fixedArgs ?? {}, key),
    )
  )
    return null;
  const normalize = (s: string) =>
    s
      .normalize("NFKC")
      .toLocaleLowerCase()
      .replace(/[.!?。！？]+$/u, "")
      .trim();
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const utterance of Object.values(intent.utterances).flat()) {
    const keys: string[] = [];
    let pattern = "";
    let end = 0;
    for (const match of utterance.matchAll(/\{([^{}]+)\}/g)) {
      pattern += escape(normalize(utterance.slice(end, match.index))) + "\\s*";
      const key = match[1];
      const slot = intent.slots?.[key];
      const values = hasOwn(intent.fixedArgs ?? {}, key)
        ? [String(intent.fixedArgs![key])]
        : slot?.type === "enum"
          ? slot.values
          : undefined;
      if (!values?.length) {
        pattern = "";
        break;
      }
      pattern += `(${values.map((v) => escape(normalize(v))).join("|")})\\s*`;
      keys.push(key);
      end = match.index! + match[0].length;
    }
    if (keys.length === 0 && utterance.includes("{")) continue;
    pattern += escape(normalize(utterance.slice(end)));
    const match = new RegExp(`^${pattern}$`, "u").exec(normalize(phrase));
    if (!match) continue;
    const args = { ...intent.fixedArgs };
    keys.forEach((key, i) => {
      args[key] ??= intent.slots?.[key]?.values?.find(
        (v) => normalize(v) === match[i + 1],
      );
    });
    return args;
  }
  return null;
}
