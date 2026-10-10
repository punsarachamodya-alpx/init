export { ClaudeExtractor, DEFAULT_MODEL } from './claudeExtractor.ts';
export type { MessagesClient } from './claudeExtractor.ts';
export { ConfirmationError, confirmSuggestion } from './confirm.ts';
export type { Confirmation, ConfirmationErrorCode } from './confirm.ts';
export { intake } from './intake.ts';
export type { IntakeInput } from './intake.ts';
export { SYSTEM_PROMPT } from './prompt.ts';
export { EXTRACTION_JSON_SCHEMA } from './schema.ts';
export { buildSuggestion, failedSuggestion, normaliseFields, suggestOccurredAt } from './suggest.ts';
export { ExtractionFailedError, FIELD_NAMES } from './types.ts';
export type {
  DocType,
  ExtractionInput,
  Extractor,
  FieldName,
  Fields,
  Issue,
  RawExtraction,
  Suggestion,
  SuggestionEvidence,
} from './types.ts';
