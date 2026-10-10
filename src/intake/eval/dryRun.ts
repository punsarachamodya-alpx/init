import type { Extractor, FieldName, RawExtraction } from '../types.ts';
import { FIELD_NAMES } from '../types.ts';
import type { EvalItem } from './items.ts';

/**
 * Fake extractors that prove the SCORER works. They are not model results.
 *  - oracle: returns the labels (a model that is always right) -> 100%.
 *  - flawed: the oracle with planted mistakes -> the scorer must list them.
 */
export function dryRunExtractor(mode: 'oracle' | 'flawed', items: EvalItem[]): Extractor {
  const byText = new Map(items.map((i, index) => [i.text, { item: i, index }]));

  return {
    extract: async (input): Promise<RawExtraction> => {
      const hit = byText.get(input.text);
      if (!hit) throw new Error('dry run: unknown item text');
      const { item, index } = hit;

      const fields: Partial<Record<FieldName, string | boolean | null>> = Object.fromEntries(FIELD_NAMES.map((f) => [f, null]));
      Object.assign(fields, item.expectedFields);
      // A reasonable model still reports a container number it can see, even when no event is expected.
      if (item.expectedEvent === null) fields.container_no = /[A-Z]{4}\d{7}/.exec(item.text)?.[0] ?? null;

      const raw: RawExtraction = {
        docType: item.docType ?? null,
        suggestedEvent: item.expectedEvent,
        language: item.language ?? 'en',
        notes: null,
        fields,
      };

      if (mode === 'flawed') {
        if (index === 0) raw.fields.bl_no = 'ESLCMB000999'; // wrong value
        if (index === 1) raw.fields.channel = 'red'; // wrong value
        if (index === 2) raw.fields.vessel = null; // missed field
        if (index === 3) raw.suggestedEvent = 'gate_pass'; // wrong event
        if (index === 5) raw.suggestedEvent = 'delivered'; // proposes an event for the invalid container
      }
      return raw;
    },
  };
}
