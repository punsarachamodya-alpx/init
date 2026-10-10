import type { CompanyClient } from '../db/withCompany.ts';
import { buildSuggestion, failedSuggestion } from './suggest.ts';
import { ExtractionFailedError } from './types.ts';
import type { DocType, ExtractionInput, Extractor, Suggestion, SuggestionEvidence } from './types.ts';

export type IntakeInput =
  | { kind: 'message'; text: string; channel: 'whatsapp' | 'email' | 'sms' | 'web'; language?: string }
  | { kind: 'document'; text: string; docType?: DocType };

/**
 * Store the raw message/document as evidence (company-private, append-only), extract a suggestion,
 * and return it. This NEVER writes to the event ledger: a person must confirm via confirmSuggestion.
 * An extraction failure becomes a `failed` suggestion for manual handling; any other error propagates.
 */
export async function intake(c: CompanyClient, extractor: Extractor, input: IntakeInput): Promise<Suggestion> {
  let evidence: SuggestionEvidence;
  if (input.kind === 'message') {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO messages (company_id, channel, language, body) VALUES (app_company_id(), $1, $2, $3) RETURNING id',
      [input.channel, input.language ?? 'und', input.text],
    );
    evidence = { type: 'message', messageId: rows[0]!.id };
  } else {
    const { rows } = await c.query<{ id: string }>(
      'INSERT INTO documents (company_id, doc_type, text_content) VALUES (app_company_id(), $1, $2) RETURNING id',
      [input.docType ?? 'other', input.text],
    );
    evidence = { type: 'document', documentId: rows[0]!.id };
  }

  const extractionInput: ExtractionInput = { kind: input.kind, text: input.text };
  try {
    return buildSuggestion(await extractor.extract(extractionInput), extractionInput, evidence);
  } catch (err) {
    if (err instanceof ExtractionFailedError) return failedSuggestion(err.reason, evidence);
    throw err;
  }
}
