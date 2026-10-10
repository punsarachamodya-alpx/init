/**
 * The import status chain. Do not add statuses outside this list; `exam` is only
 * recorded when the customs channel requires a physical inspection.
 * Keep in sync with the CHECK constraint and view in db/migrations/0001_init.sql
 * (tests/ledger.test.ts stores every value, so drift fails the build).
 */
export const EVENT_TYPES = [
  'vessel_discharged',
  'do_received',
  'cusdec_lodged',
  'channel_assigned',
  'exam',
  'release_advice',
  'gate_pass',
  'truck_dispatched',
  'picked_up',
  'delivered',
  'empty_returned',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EXAM_YARDS = ['RCT', 'Grayline 1', 'Grayline 2'] as const;

export const ROLES = ['cha_ops', 'client', 'haulier_dispatcher'] as const;
export type RoleName = (typeof ROLES)[number];

const CLEARANCE = ['do_received', 'cusdec_lodged', 'channel_assigned', 'exam', 'release_advice'] as const;
const TRUCKING = ['gate_pass', 'truck_dispatched', 'picked_up', 'delivered', 'empty_returned'] as const;

/**
 * Who may record which stage (SPEC section 2). Mirrors the SQL function event_allowed() in
 * db/migrations/0006_shared_events.sql; tests/roles.test.ts checks every role x type pair.
 * The CHA does not record trucking stages: the haulier dispatcher confirms those.
 */
export const ROLE_EVENT_TYPES: Readonly<Record<RoleName, readonly EventType[]>> = {
  cha_ops: ['vessel_discharged', ...CLEARANCE],
  client: [...CLEARANCE],
  haulier_dispatcher: [...TRUCKING],
};

export function eventAllowed(role: string, type: EventType): boolean {
  return (ROLE_EVENT_TYPES as Record<string, readonly EventType[] | undefined>)[role]?.includes(type) ?? false;
}

export const CHANNELS = ['green', 'yellow', 'red', 'blue'] as const;

/**
 * Keys allowed in an event payload, with value rules. Hauliers can read events, so the payload is
 * constrained by shape, not just by key name (mirrors payload_ok() in db/migrations/0009_payload_rules.sql;
 * tests/payloadRules.test.ts checks both agree). Free text is still human-entered and visible to
 * hauliers: never enter prices or charges there.
 */
export const PAYLOAD_KEYS = ['yard', 'result', 'note', 'scheduled_at', 'pickup_window', 'reference'] as const;
export type PayloadKey = (typeof PAYLOAD_KEYS)[number];
export type EventPayload = Partial<Record<PayloadKey, string>>;

const ISO_UTC = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z`;
const RULES: Record<PayloadKey, (v: string) => boolean> = {
  yard: (v) => (EXAM_YARDS as readonly string[]).includes(v),
  result: (v) => (CHANNELS as readonly string[]).includes(v),
  scheduled_at: (v) => new RegExp(`^${ISO_UTC}$`).test(v),
  pickup_window: (v) => new RegExp(`^${ISO_UTC}/${ISO_UTC}$`).test(v),
  reference: (v) => /^[A-Za-z0-9._/-]{1,64}$/.test(v),
  note: (v) => [...v].length <= 140,
};

export function isValidPayloadEntry(key: string, value: unknown): boolean {
  return (PAYLOAD_KEYS as readonly string[]).includes(key) && typeof value === 'string' && RULES[key as PayloadKey](value);
}

export function isValidPayload(p: unknown): boolean {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) return false;
  return Object.entries(p).every(([k, v]) => isValidPayloadEntry(k, v));
}
