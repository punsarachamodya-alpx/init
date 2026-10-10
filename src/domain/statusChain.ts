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

/**
 * Keys allowed in an event payload. Hauliers can read events, so the payload must never carry
 * commercial data (freight, demurrage, tariffs, prices). Mirrors payload_ok() in the database.
 */
export const PAYLOAD_KEYS = ['yard', 'result', 'note', 'scheduled_at', 'pickup_window', 'reference'] as const;
export type PayloadKey = (typeof PAYLOAD_KEYS)[number];
export type EventPayload = Partial<Record<PayloadKey, string | number | boolean | null>>;
