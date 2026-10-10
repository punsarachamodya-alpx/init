// Score intake extraction against fixtures/labels.json (read-only ground truth).
//   pnpm eval:intake                    real run: needs ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN); spends API credit
//   pnpm eval:intake --dry-run=oracle   scorer check with a perfect fake extractor (not a model result)
//   pnpm eval:intake --dry-run=flawed   scorer check with planted mistakes (not a model result)
// Exit code: 0 no misses, 1 misses, 2 cannot run.
import path from 'node:path';
import { ClaudeExtractor, DEFAULT_MODEL } from '../src/intake/claudeExtractor.ts';
import { EvalAbortedError, dryRunExtractor, evaluate, formatReport, loadEvalItems, resolveLabelsPath } from '../src/intake/eval/index.ts';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const labels = resolveLabelsPath(arg('labels'), path.resolve(import.meta.dirname, '../fixtures')); // inside fixtures/ only
const items = loadEvalItems(labels);

const dry = arg('dry-run');
let extractor;
let label: string;
if (dry) {
  if (dry !== 'oracle' && dry !== 'flawed') {
    console.error('--dry-run must be oracle or flawed');
    process.exit(2);
  }
  console.log(`DRY RUN (${dry}): fake extractor, proves the scorer only. These are NOT model results.\n`);
  label = `DRY RUN (${dry}) - NOT MODEL RESULTS`;
  extractor = dryRunExtractor(dry, items);
} else {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
    console.error('No ANTHROPIC_API_KEY (or ANTHROPIC_AUTH_TOKEN) in the environment, so the real eval cannot run.');
    console.error('Add the key as an environment variable / secret, start a new session, and run again.');
    process.exit(2);
  }
  const model = process.env.INTAKE_MODEL ?? DEFAULT_MODEL;
  console.log(`REAL RUN: model ${model}, ${items.length} synthetic items.\n`);
  label = `REAL RUN (${model})`;
  extractor = new ClaudeExtractor({ model });
}

try {
  const report = await evaluate(items, extractor, { label });
  console.log(formatReport(report));
  process.exit(report.misses.length === 0 ? 0 : 1);
} catch (err) {
  if (err instanceof EvalAbortedError) {
    console.error(err.message);
    process.exit(2);
  }
  throw err;
}
