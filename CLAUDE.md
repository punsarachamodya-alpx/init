# Colombo Release Tracker

WhatsApp-first container release tracker and dispatch board for Colombo import clearance and hinterland trucking. Pilot scope: one clearing agent, 2-3 hauliers, 2 importer/exporter clients.

The app tracks and coordinates. It never files customs declarations. Only licensed CHAs file CusDecs in ASYCUDA World.

## Commands
Stack: TypeScript, Next.js (App Router), PostgreSQL with row-level security, pg-boss job queue, Vitest, Playwright, pnpm. Scripts are created in Prompt 2; until then only the ISO 6346 script exists. See SPEC.md.
- `pnpm dev` - run the app locally
- `pnpm test` - unit and integration tests (Vitest)
- `pnpm e2e` - Playwright end-to-end tests
- `pnpm typecheck` - `tsc --noEmit`
- `pnpm lint` - lint
- `pnpm db:migrate` - apply new migrations (never edit existing ones)
- `pnpm eval:intake` - score extraction against fixtures/labels.json (Prompt 3)
- `node scripts/check-iso6346.mjs <container_no...>` - validate container number check digits

## Rules
- The event ledger is append-only. Never UPDATE or DELETE event rows. Corrections are new events that reference the one they correct.
- Every table has `company_id`, and row-level security enforces it. No query runs without a company context.
- Tests use `/fixtures/synthetic` only. Never put real driver, company, container or document data in the repo.
- Extraction from messages and documents is a suggestion. A person confirms every extracted field before it becomes an event.
- Every status change records its source (who or what) and evidence (message id, document id, or manual entry).
- Store timestamps in UTC. Display in Asia/Colombo.
- UI text lives in `/locales` with `en`, `si` and `ta` keys. No hardcoded user-facing strings.
- Validate container numbers with the ISO 6346 check digit before saving.
- Do not edit existing migrations, `.env*` files or lockfiles by hand. Hooks block this.

## Domain glossary
- **CusDec**: customs declaration, lodged by the CHA in ASYCUDA World.
- **DO**: delivery order from the shipping line. Needs original BL and freight paid.
- **DA / e-DA**: delivery advice from the terminal that cargo is cleared for pickup.
- **Exam yard**: physical inspection after the customs channel is assigned (RCT, Grayline 1, Grayline 2).
- **CHA**: customs house agent (the licensed clearing agent).
- **Gate pass**: terminal permission for a truck to collect a container.

## Import status chain (do not invent statuses outside this)
vessel discharged -> DO received -> CusDec lodged -> channel assigned -> (exam, if selected) -> release / delivery advice -> gate pass -> truck dispatched -> picked up -> delivered -> empty returned

## Workflow
- For any change touching more than 2 files, write a plan first and wait for approval.
- One task per commit. Small commits with clear messages.
- Before saying a task is done, run `pnpm typecheck && pnpm test` and show the output.
- After finishing a feature, run the `domain-reviewer` subagent on the diff.
- Use `/clear` between unrelated tasks.
