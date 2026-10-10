import { EVENT_TYPES } from '../domain/statusChain.ts';
import { BOOLEAN_FIELDS, DOC_TYPES, FIELD_NAMES } from './types.ts';

const nullableString = { type: ['string', 'null'] } as const;
const nullableBoolean = { type: ['boolean', 'null'] } as const;

/** JSON schema for structured output (`output_config.format`). Closed: every field required, nullable. */
export const EXTRACTION_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['doc_type', 'suggested_event', 'language', 'fields', 'notes'],
  properties: {
    doc_type: { type: ['string', 'null'], enum: [...DOC_TYPES, null] },
    suggested_event: { type: ['string', 'null'], enum: [...EVENT_TYPES, null] },
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
