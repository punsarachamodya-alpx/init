import { EVENT_TYPES } from '../domain/statusChain.ts';
import { BOOLEAN_FIELDS, DOC_TYPES, FIELD_NAMES } from './types.ts';

const NULL = { type: 'null' } as const;
const nullableString = { anyOf: [{ type: 'string' }, NULL] } as const;
const nullableBoolean = { anyOf: [{ type: 'boolean' }, NULL] } as const;

/** JSON schema for structured output (`output_config.format`). Closed: every field required, nullable. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'suggested_event', 'language', 'fields', 'notes'],
  properties: {
    doc_type: { anyOf: [{ type: 'string', enum: [...DOC_TYPES] }, NULL] },
    suggested_event: { anyOf: [{ type: 'string', enum: [...EVENT_TYPES] }, NULL] },
    language: nullableString,
    notes: nullableString,
    fields: {
      type: 'object',
      additionalProperties: false,
      required: [...FIELD_NAMES],
      properties: Object.fromEntries(FIELD_NAMES.map((f) => [f, BOOLEAN_FIELDS.includes(f) ? nullableBoolean : nullableString])),
    },
  },
} as const;
