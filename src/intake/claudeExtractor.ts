import Anthropic from '@anthropic-ai/sdk';
import { SYSTEM_PROMPT } from './prompt.ts';
import { EXTRACTION_JSON_SCHEMA } from './schema.ts';
import { ExtractionFailedError, FIELD_NAMES } from './types.ts';
import type { ExtractionInput, Extractor, FieldValue, RawExtraction } from './types.ts';

export const DEFAULT_MODEL = 'claude-opus-5-5';

/** The slice of the SDK client the extractor uses (lets tests inject a fake). */
export interface MessagesClient {
  messages: {
    create(params: Record<string, unknown>): Promise<{
      stop_reason: string | null;
      content: Array<{ type: string; text?: string }>;
    }>;
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const nullableString = (v: unknown): string | null | undefined => (v === null || typeof v === 'string' ? v : undefined);

function toRawExtraction(json: unknown): RawExtraction {
  if (!isRecord(json) || !isRecord(json.fields)) throw new ExtractionFailedError('invalid_output');
  const docType = nullableString(json.doc_type);
  const suggestedEvent = nullableString(json.suggested_event);
  const language = nullableString(json.language);
  const notes = nullableString(json.notes);
  if ([docType, suggestedEvent, language, notes].includes(undefined)) throw new ExtractionFailedError('invalid_output');

  const fields: RawExtraction['fields'] = {};
  for (const name of FIELD_NAMES) {
    const v = json.fields[name];
    if (v === undefined || v === null) fields[name] = null;
    else if (typeof v === 'string' || typeof v === 'boolean') fields[name] = v as FieldValue;
    else throw new ExtractionFailedError('invalid_output');
  }
  return { docType: docType!, suggestedEvent: suggestedEvent!, language: language!, notes: notes!, fields };
}

/**
 * Extracts a suggestion with the Claude API (structured output). Instructions are in the system
 * prompt; the untrusted text is only in the user turn, inside <message>/<document> delimiters.
 * No prefill, no forced tool use and no sampling parameters (not accepted by this model family).
 */
export class ClaudeExtractor implements Extractor {
  private readonly client: MessagesClient;
  private readonly model: string;

  constructor(opts: { client?: MessagesClient; model?: string } = {}) {
    this.client = opts.client ?? (new Anthropic() as unknown as MessagesClient);
    this.model = opts.model ?? process.env.INTAKE_MODEL ?? DEFAULT_MODEL;
  }

  async extract(input: ExtractionInput): Promise<RawExtraction> {
    let response;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: 2000,
        system: SYSTEM_PROMPT,
        output_config: { effort: 'low', format: { type: 'json_schema', schema: EXTRACTION_JSON_SCHEMA } },
        messages: [{ role: 'user', content: `<${input.kind}>\n${input.text}\n</${input.kind}>` }],
      });
    } catch (cause) {
      throw new ExtractionFailedError('api_error', { cause });
    }
    if (response.stop_reason === 'refusal') throw new ExtractionFailedError('refusal');
    if (response.stop_reason === 'max_tokens') throw new ExtractionFailedError('max_tokens');

    const text = response.content.find((b) => b.type === 'text')?.text;
    if (text === undefined) throw new ExtractionFailedError('invalid_output');
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch (cause) {
      throw new ExtractionFailedError('invalid_output', { cause });
    }
    return toRawExtraction(json);
  }
}
