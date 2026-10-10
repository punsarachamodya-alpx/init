import { ClaudeExtractor } from '../intake/claudeExtractor.ts';
import { scanContainerTokens } from '../intake/suggest.ts';
import { ExtractionFailedError } from '../intake/types.ts';
import type { ExtractionInput, Extractor, RawExtraction } from '../intake/types.ts';

/** Always fails, so intake stores a `failed` suggestion and staff use manual entry (no API key configured). */
export class UnavailableExtractor implements Extractor {
  async extract(): Promise<RawExtraction> {
    throw new ExtractionFailedError('api_error');
  }
}

const STAGES: Array<[RegExp, string]> = [
  [/empty\s+(?:container\s+)?return/i, 'empty_returned'],
  [/\bdeliver(?:ed|y completed)\b/i, 'delivered'],
  [/picked\s*up|collected/i, 'picked_up'],
  [/dispatch/i, 'truck_dispatched'],
  [/gate\s*pass/i, 'gate_pass'],
  [/\be-?da\b|delivery advice|released?\b/i, 'release_advice'],
  [/\bexam/i, 'exam'],
  [/channel\s+(?:assigned|is)?\s*(?:green|yellow|red|blue)|channel assigned/i, 'channel_assigned'],
  [/cusdec|customs declaration/i, 'cusdec_lodged'],
  [/\bD\/?O\b|delivery order/i, 'do_received'],
  [/discharged/i, 'vessel_discharged'],
];

/**
 * Deterministic stand-in for the model, for the browser tests and local demos ONLY (INTAKE_EXTRACTOR=fake, refused in
 * production). It is not a model result and proves nothing about extraction quality. Its output still goes through the
 * same trusted checks (ISO 6346, grounding) and the same human confirmation as the real extractor's.
 */
export class RuleExtractor implements Extractor {
  async extract(input: ExtractionInput): Promise<RawExtraction> {
    const container = scanContainerTokens(input.text).valid[0] ?? null;
    const bl = /B\/?L(?:\s*No\.?)?\s*[:#]?\s*([A-Z0-9]{6,})/i.exec(input.text)?.[1]?.toUpperCase() ?? null;
    const stage = STAGES.find(([re]) => re.test(input.text))?.[1] ?? null;
    return {
      docType: input.kind === 'document' ? 'other' : null,
      suggestedEvent: container ? stage : null,
      language: 'en',
      notes: null,
      fields: { container_no: container, bl_no: bl },
    };
  }
}

/** Real model when ANTHROPIC_API_KEY is set; the rule-based fake only when asked for, never in production; otherwise manual entry. */
export function selectExtractor(env: { NODE_ENV?: string; INTAKE_EXTRACTOR?: string; ANTHROPIC_API_KEY?: string } = process.env): Extractor {
  if (env.INTAKE_EXTRACTOR === 'fake') {
    if (env.NODE_ENV === 'production') throw new Error('INTAKE_EXTRACTOR=fake is not allowed in production');
    return new RuleExtractor();
  }
  if (env.ANTHROPIC_API_KEY) return new ClaudeExtractor();
  return new UnavailableExtractor();
}

/** What is stored as the suggestion's `extractor` label. */
export function extractorLabel(env: { NODE_ENV?: string | undefined; INTAKE_EXTRACTOR?: string | undefined; ANTHROPIC_API_KEY?: string | undefined; INTAKE_MODEL?: string | undefined } = process.env): string {
  if (env.INTAKE_EXTRACTOR === 'fake') return 'rules-fake';
  return env.ANTHROPIC_API_KEY ? (env.INTAKE_MODEL ?? 'claude') : 'none';
}
