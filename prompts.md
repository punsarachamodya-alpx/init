# Ordered prompts

Run these in order, one per fresh session (`/clear` between them). Start each in plan mode (Shift+Tab twice). Do not move on until the stated check passes.

---

## Prompt 1 - Spec interview and stack decision

```
I want to build a WhatsApp-first container release tracker and dispatch board for Colombo import clearance. Read CLAUDE.md first.

Interview me about the product using the AskUserQuestion tool. Ask about the pilot workflow, who sends which message, what a clearing agent does at each step, what a haulier needs to see, edge cases (LCL, exam yard, DO expiry, demurrage), and what must NOT be built. Ask one topic at a time and keep going until the spec is complete.

Then write SPEC.md covering: users, the status chain, the message flows, the screens, and out-of-scope items. Also propose the stack (default: TypeScript, Postgres with row-level security, a job queue on Postgres, Playwright) and update the Commands section in CLAUDE.md to the real commands.
```

Check: SPEC.md exists, you agree with every line, CLAUDE.md commands are real.

---

## Prompt 2 - Walking skeleton with the event ledger

```
Using SPEC.md and CLAUDE.md, scaffold the project and build the smallest end-to-end slice:
1. Postgres schema and the first migration for Company, Container, Event, Message, Document with company_id and row-level security on every table.
2. An append-only event ledger (no update or delete path, corrections reference the event they correct).
3. ISO 6346 validation using scripts/check-iso6346.mjs as the reference.
4. Tests that prove: cross-company reads are impossible, ledger rows cannot be changed, invalid container numbers are rejected.

Plan first. Write the tests before the implementation. Run `pnpm typecheck && pnpm test` and show the output. Then run the domain-reviewer subagent on the diff.
```

Check: tests fail first, then pass. Try a cross-company query by hand and confirm it returns nothing.

---

## Prompt 3 - Intake with extraction, scored against labels

```
Build the Intake module. It takes a WhatsApp-style text message or a document (text from fixtures/synthetic), calls the Claude API with structured output to extract the fields, and returns a SUGGESTED event. A person must confirm before anything is written to the ledger.

Score it: write an eval script that runs every item in fixtures/labels.json and prints per-field accuracy and a list of misses. Do not edit labels.json. Cover the Romanised Sinhala message and the invalid check-digit message.

Plan first. Show the eval output. Then run the domain-reviewer subagent.
```

Check: eval output reads sensibly, invalid container is rejected, no path writes an event without confirmation.

---

## Prompt 4 - Tracker view and notifications

```
Build the ops dashboard and notifications:
1. A board listing containers by current status with age in each status and the evidence for the last change.
2. A one-tap confirm flow for suggested events.
3. Outbound notification stubs (WhatsApp, email, SMS fallback) behind an interface, with a fake provider for tests.
4. UI strings in /locales for en, si and ta.

Plan first. Add Playwright tests for: confirm a suggested event, see it on the board, switch language. Run `pnpm typecheck && pnpm test && pnpm e2e`, show the output, then run the domain-reviewer subagent.
```

Check: open the board yourself with the synthetic data and walk the full chain for one container.

---

## Habits that keep sessions clean
- If Claude has been corrected twice on the same thing, `/clear` and restart with a better prompt.
- When CLAUDE.md grows past what you would read in a minute, prune it. If a rule keeps being ignored, move it into a hook.
- Use `/hooks` to confirm the hooks are loaded.
- For a second feature in parallel, use a git worktree so sessions do not collide.
