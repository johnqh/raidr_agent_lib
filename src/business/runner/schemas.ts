/**
 * The shapes the six ShapeShyft endpoints must answer with. Model output is
 * untrusted: every answer goes through one of these before it is used, on the
 * server (cloud runs) and on the device (local runs) alike.
 *
 * Parsing is tolerant: a W the model got wrong becomes `null`, an unknown
 * enum value falls back to a safe default, numbers are clamped, and one bad
 * entry in a list is dropped rather than failing the whole answer. Only the
 * keys a step cannot work without are strictly required.
 *
 * The JSON Schemas sent to ShapeShyft (`STEP_SCHEMAS` in `./stepSchemas`) are
 * kept in step with these; `stepSchemas.test.ts` checks that they agree.
 */
import { z } from 'zod';
import { LABEL_RE } from '@sudobility/raidr_types';
import {
  type AgentIntent,
  type FormField,
  type FormFieldType,
  type FormValue,
  type IntentWhen,
  type IntentWhere,
  type IntentWho,
  RESULT_KINDS,
  type ResultKind,
  SELECTION_MODES,
  type SelectionMode,
  type SiteLogin,
} from '@sudobility/raidr_agent_types';

// =============================================================================
// Helpers
// =============================================================================

/** A list whose invalid entries are dropped (not fatal), capped at `max`. */
export function lenientArray<T extends z.ZodType>(item: T, max: number) {
  return z
    .unknown()
    .optional()
    .transform(value =>
      (Array.isArray(value) ? value : [])
        .flatMap(entry => {
          const parsed = item.safeParse(entry);
          return parsed.success ? [parsed.data as z.output<T>] : [];
        })
        .slice(0, max)
    );
}

/** A trimmed string, or null when missing, blank or not a string. Capped. */
const optionalText = (max: number) =>
  z
    .unknown()
    .optional()
    .transform(value =>
      typeof value === 'string' && value.trim()
        ? value.trim().slice(0, max)
        : null
    );

/** Round and clamp a finite number into [min, max]; anything else → undefined. */
function clampInt(value: unknown, min: number, max: number) {
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(max, Math.max(min, Math.round(n)));
}

/** `YYYY-MM-DD` or an ISO 8601 date-time. */
const ISO_DATE_RE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;

function isoText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  return ISO_DATE_RE.test(text) &&
    !Number.isNaN(Date.parse(text.replace(' ', 'T')))
    ? text
    : undefined;
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim()
    ? value.trim().slice(0, max)
    : null;
}

// =============================================================================
// understand-intent
// =============================================================================

function toWho(value: unknown): IntentWho | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const kind =
    raw.kind === 'party' ? 'party' : raw.kind === 'self' ? 'self' : null;
  if (!kind) return null;
  const partySize = clampInt(raw.partySize, 1, 100);
  const description = text(raw.description, 200);
  return {
    kind,
    ...(partySize !== undefined ? { partySize } : {}),
    ...(description ? { description } : {}),
  };
}

function toWhen(value: unknown): IntentWhen | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const words = text(raw.text, 120);
  const start = isoText(raw.start);
  const end = isoText(raw.end);
  if (!words && !start) return null;
  return {
    text: words ?? start ?? '',
    ...(start ? { start } : {}),
    ...(end ? { end } : {}),
  };
}

const PLACE_ROLES = ['area', 'origin', 'destination', 'stop'] as const;
type PlaceRole = (typeof PLACE_ROLES)[number];

function toWhere(value: unknown): IntentWhere | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const places = (Array.isArray(raw.places) ? raw.places : [])
    .flatMap(p => {
      if (!p || typeof p !== 'object') return [];
      const place = p as Record<string, unknown>;
      const name = text(place.name, 120);
      if (!name) return [];
      const role = (PLACE_ROLES as readonly unknown[]).includes(place.role)
        ? (place.role as PlaceRole)
        : undefined;
      return [{ name, ...(role ? { role } : {}) }];
    })
    .slice(0, 6);
  if (raw.kind === 'current') return { kind: 'current', places };
  if (places.length === 0) return null;
  if (raw.kind === 'place' || raw.kind === 'places')
    return { kind: places.length > 1 ? 'places' : 'place', places };
  return null;
}

/** `understand-intent` output. {@link toAgentIntent} normalises it. */
export const understandOutputSchema = z.object({
  intent: z
    .string()
    .trim()
    .min(1)
    .transform(s => s.slice(0, 60)),
  labels: lenientArray(z.string(), 6),
  slots: lenientArray(
    z.object({
      name: z.string().trim().min(1).max(60),
      value: z
        .string()
        .trim()
        .min(1)
        .transform(s => s.slice(0, 200)),
    }),
    10
  ),
  resultKind: z
    .unknown()
    .optional()
    .transform((v): ResultKind =>
      (RESULT_KINDS as readonly unknown[]).includes(v)
        ? (v as ResultKind)
        : 'generic'
    ),
  query: optionalText(300),
  what: optionalText(200),
  who: z.unknown().optional().transform(toWho),
  how: optionalText(300),
  when: z.unknown().optional().transform(toWhen),
  where: z.unknown().optional().transform(toWhere),
  why: optionalText(300),
  selection: z
    .unknown()
    .optional()
    .transform((v): SelectionMode =>
      (SELECTION_MODES as readonly unknown[]).includes(v)
        ? (v as SelectionMode)
        : 'all'
    ),
  location_needed: z
    .unknown()
    .optional()
    .transform(v => v === true),
});

/**
 * Validate an `understand-intent` answer and normalise it into an
 * {@link AgentIntent}: labels lowercased and kept only when they are valid
 * label slugs, an unknown `resultKind` becomes `generic`, an unknown
 * `selection` becomes `all`, a W that does not parse becomes `null`, an empty
 * query falls back to the request text and `what` to the intent.
 * `location_needed` is `where.kind === 'current'` (a model that says it needs
 * the location but names no place gets `where: { kind: 'current' }`).
 *
 * @throws ZodError when the output is not an object with an `intent`.
 */
export function toAgentIntent(output: unknown, request: string): AgentIntent {
  const raw = understandOutputSchema.parse(output);
  const labels = [
    ...new Set(
      raw.labels.map(l => l.toLowerCase().trim()).filter(l => LABEL_RE.test(l))
    ),
  ];
  const where: IntentWhere | null =
    raw.where ?? (raw.location_needed ? { kind: 'current', places: [] } : null);
  return {
    location_needed: where?.kind === 'current',
    intent: raw.intent,
    labels,
    slots: raw.slots,
    resultKind: raw.resultKind,
    query: raw.query ?? request.trim().slice(0, 300),
    what: raw.what ?? raw.intent,
    who: raw.who,
    how: raw.how,
    when: raw.when,
    where,
    why: raw.why,
    selection: raw.selection,
  };
}

/**
 * A strict {@link AgentIntent}, for intents that come back from a client
 * (`POST /prepare`, `POST /runs`, `POST /runs/import`): already normalised,
 * so anything off is a bad request, not a model slip.
 */
export const agentIntentSchema = z.object({
  location_needed: z.boolean(),
  intent: z.string().min(1).max(60),
  labels: z.array(z.string().regex(LABEL_RE)).max(6),
  slots: z
    .array(z.object({ name: z.string().max(60), value: z.string().max(200) }))
    .max(10),
  resultKind: z.enum(RESULT_KINDS as [ResultKind, ...ResultKind[]]),
  query: z.string().max(300),
  what: z.string().max(200),
  who: z
    .object({
      kind: z.enum(['self', 'party']),
      partySize: z.number().int().min(1).max(100).optional(),
      description: z.string().max(200).optional(),
    })
    .nullable(),
  how: z.string().max(300).nullable(),
  when: z
    .object({
      text: z.string().max(120),
      start: z.string().max(40).optional(),
      end: z.string().max(40).optional(),
    })
    .nullable(),
  where: z
    .object({
      kind: z.enum(['current', 'place', 'places']),
      places: z
        .array(
          z.object({
            name: z.string().max(120),
            role: z.enum(PLACE_ROLES).optional(),
          })
        )
        .max(6),
    })
    .nullable(),
  why: z.string().max(300).nullable(),
  selection: z.enum(SELECTION_MODES as [SelectionMode, ...SelectionMode[]]),
}) satisfies z.ZodType<AgentIntent>;

// =============================================================================
// rank-sites
// =============================================================================

/** `rank-sites` output: sites best first, each with why it fits. */
export const rankSitesSchema = z.object({
  sites: lenientArray(
    z.object({
      apiHost: z.string().trim().min(1),
      reason: z
        .unknown()
        .optional()
        .transform(v => text(v, 300) ?? ''),
    }),
    50
  ),
});

// =============================================================================
// prepare-site
// =============================================================================

const FORM_FIELD_TYPES: readonly FormFieldType[] = [
  'text',
  'number',
  'date',
  'datetime',
  'select',
  'multiselect',
  'boolean',
];

const SITE_LOGINS: readonly SiteLogin[] = ['required', 'fallback', 'none'];

/** `Party Size` / `partySize` / `party-size` → `party_size`; null when nothing usable is left. */
export function canonicalFieldName(name: string): string | null {
  const snake = name
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return /^[a-z][a-z0-9_]*$/.test(snake) ? snake : null;
}

function humanize(name: string): string {
  const words = name.replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function toOption(o: unknown): { value: string; label: string } | null {
  if (typeof o === 'string' || typeof o === 'number') {
    const value = String(o).trim().slice(0, 200);
    return value ? { value, label: value } : null;
  }
  if (!o || typeof o !== 'object') return null;
  const raw = o as Record<string, unknown>;
  if (typeof raw.value !== 'string' && typeof raw.value !== 'number')
    return null;
  const value = String(raw.value).trim().slice(0, 200);
  if (!value) return null;
  return { value, label: text(raw.label, 200) ?? value };
}

/** Coerce a model-supplied default to the field's type; undefined when it does not fit. */
function coerceDefault(
  value: unknown,
  type: FormFieldType,
  options: { value: string }[] | undefined
): FormValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  switch (type) {
    case 'number': {
      const n =
        typeof value === 'string' && value.trim() ? Number(value) : value;
      return typeof n === 'number' && Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      if (value === 'true' || value === 'false') return value === 'true';
      return undefined;
    case 'multiselect': {
      const list = (Array.isArray(value) ? value : [value])
        .filter(v => typeof v === 'string' || typeof v === 'number')
        .map(String)
        .filter(v => !options || options.some(o => o.value === v));
      return list.length > 0 ? list.slice(0, 50) : undefined;
    }
    case 'select': {
      const v = typeof value === 'number' ? String(value) : value;
      if (typeof v !== 'string') return undefined;
      return !options || options.some(o => o.value === v) ? v : undefined;
    }
    default: {
      const v = typeof value === 'number' ? String(value) : value;
      return typeof v === 'string' ? v.slice(0, 500) : undefined;
    }
  }
}

/** One form field from the model, normalised; null when it cannot be used. */
export function toFormField(value: unknown): FormField | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  const name =
    typeof raw.name === 'string' ? canonicalFieldName(raw.name) : null;
  if (!name) return null;
  let type: FormFieldType = (FORM_FIELD_TYPES as readonly unknown[]).includes(
    raw.type
  )
    ? (raw.type as FormFieldType)
    : 'text';
  const options = (Array.isArray(raw.options) ? raw.options : [])
    .map(toOption)
    .filter((o): o is { value: string; label: string } => o !== null)
    .filter((o, i, all) => all.findIndex(x => x.value === o.value) === i)
    .slice(0, 50);
  // A select without choices is a text box.
  if ((type === 'select' || type === 'multiselect') && options.length === 0)
    type = 'text';
  const withOptions = type === 'select' || type === 'multiselect';
  const description = text(raw.description, 300);
  const fallback = coerceDefault(
    raw.default,
    type,
    withOptions ? options : undefined
  );
  return {
    name,
    label: text(raw.label, 80) ?? humanize(name),
    type,
    required: raw.required === true,
    ...(description ? { description } : {}),
    ...(withOptions ? { options } : {}),
    ...(fallback !== undefined ? { default: fallback } : {}),
  };
}

/** Most form fields one site may ask for. */
export const MAX_FORM_FIELDS = 8;
/** Most tools `prepare` may choose for one site. */
export const MAX_PREPARED_TOOLS = 6;

/** `prepare-site` output. `tools` are checked against the site's tools by the caller. */
export const prepareSchema = z.object({
  // The one key that must be there: a list (possibly empty) of tool names.
  tools: z.array(z.unknown()).transform(list =>
    list
      .filter((t): t is string => typeof t === 'string' && t.trim() !== '')
      .map(t => t.trim())
      .slice(0, 20)
  ),
  login: z
    .unknown()
    .optional()
    .transform((v): SiteLogin =>
      (SITE_LOGINS as readonly unknown[]).includes(v)
        ? (v as SiteLogin)
        : 'none'
    ),
  loginReason: optionalText(300),
  unsupported: optionalText(300),
  fields: z
    .unknown()
    .optional()
    .transform(value => {
      const fields = (Array.isArray(value) ? value : [])
        .map(toFormField)
        .filter((f): f is FormField => f !== null);
      // One site naming a field twice: the first wins.
      return fields
        .filter((f, i) => fields.findIndex(x => x.name === f.name) === i)
        .slice(0, MAX_FORM_FIELDS);
    }),
});

// =============================================================================
// plan-calls
// =============================================================================

/** `plan-calls` output: up to 3 calls, `arguments` as a JSON string (an object is accepted too). */
export const planSchema = z.object({
  done: z.boolean(),
  calls: z
    .array(
      z.object({
        tool: z.string(),
        arguments: z.union([
          z.string(),
          z.record(z.string(), z.unknown()).transform(o => JSON.stringify(o)),
        ]),
        reason: z.string().optional(),
      })
    )
    .max(3),
});

// =============================================================================
// extract-results
// =============================================================================

/** One extracted result: a card plus `ref`, where in which response it came from. */
export const extractItemSchema = z.object({
  title: z
    .string()
    .trim()
    .min(1)
    .transform(s => s.slice(0, 500)),
  summary: z
    .unknown()
    .optional()
    .transform(v => (typeof v === 'string' ? v.trim().slice(0, 5_000) : '')),
  imageUrl: z
    .unknown()
    .optional()
    .transform(v => (typeof v === 'string' ? v : '')),
  sourceUrl: z
    .unknown()
    .optional()
    .transform(v => (typeof v === 'string' ? v : '')),
  location: z
    .object({
      latitude: z.number().finite().min(-90).max(90),
      longitude: z.number().finite().min(-180).max(180),
    })
    .nullable()
    .catch(null),
  recipe: z
    .object({
      ingredients: z.array(z.string()).max(200),
      steps: z.array(z.string()).max(200),
      totalMinutes: z.number().finite().nullable().catch(null),
      servings: z.number().finite().nullable().catch(null),
    })
    .nullable()
    .catch(null),
  fields: lenientArray(
    z.object({
      label: z.string().transform(s => s.slice(0, 200)),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .transform(v => String(v).slice(0, 2_000)),
    }),
    30
  ),
  ref: z
    .object({
      callId: z.string().trim().min(1),
      itemPath: z
        .unknown()
        .optional()
        .transform(v => (typeof v === 'string' ? v.trim() : '')),
    })
    .nullable()
    .catch(null),
});

/** Most results one site's extraction keeps. */
export const MAX_EXTRACTED = 10;

/** `extract-results` output: up to 10 result cards. */
export const extractSchema = z.object({
  items: lenientArray(extractItemSchema, MAX_EXTRACTED),
});

// =============================================================================
// pick-best
// =============================================================================

/** `pick-best` output. `bestId` is checked against the results by the caller. */
export const pickBestSchema = z.object({
  bestId: z
    .unknown()
    .optional()
    .transform(v => (typeof v === 'string' ? v.trim() : '')),
  reason: z
    .unknown()
    .optional()
    .transform(v => text(v, 500) ?? ''),
});
