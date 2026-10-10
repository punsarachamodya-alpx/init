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
