# SPEC - Colombo Release Tracker (pilot)

Status: draft for owner review. Decisions below come from the Prompt 1 interview. Items marked **ASSUMED** were not explicitly answered and need confirmation.

The app tracks and coordinates. It never files customs declarations or talks to ASYCUDA World. Only licensed CHAs file CusDecs.

## 1. Pilot scope
One clearing agent (CHA), 2-3 hauliers, 2 importer/exporter clients. Import clearance and hinterland trucking only.

## 2. Users and permissions
Every user belongs to one company (`company_id`). Roles:

| Role | Who | Can do |
|---|---|---|
| `cha_ops` | Clearing agent staff | See all containers of their clients; confirm any clearance stage; assign hauliers; manage tariff rates. |
| `client` | Importer/exporter staff | See the containers the CHA has shared with them; confirm clearance stages (DO received etc.) on those. |
| `haulier_dispatcher` | Haulier staff | See only jobs assigned to their company; confirm trucking stages (gate pass, dispatched, picked up, delivered, empty returned). |
| `driver` | Haulier driver | Reports status by WhatsApp message only. Reports are suggestions; the dispatcher confirms. No login in the pilot. |

Decisions:
- Clearance stages (DO received, CusDec lodged, channel assigned, exam, release/DA): any pilot user in the company chain for that container can confirm. Source and evidence are always recorded.
- Trucking stages: the haulier dispatcher confirms; drivers report.
- Hauliers never see commercial information (freight, demurrage estimates, client pricing, tariffs).

### Sharing and who records what (implemented, migrations 0004-0006)
- The **CHA owns** a container record and grants read access to the client and to an assigned haulier. Grants are an append-only log; a revoke is a new row and takes effect immediately for reads and writes.
- Roles are enforced in the database from the `users` table (`cha_ops`, `client`, `haulier_dispatcher`); the role is never supplied by the caller. A person's user id is also the confirming person on every event they record.
- Who may record which stage (`event_allowed`, mirrored in `src/domain/statusChain.ts`):

| Role | Stages |
|---|---|
| `cha_ops` | vessel discharged, DO received, CusDec lodged, channel assigned, exam, release / delivery advice |
| `client` (own, granted containers) | DO received, CusDec lodged, channel assigned, exam, release / delivery advice |
| `haulier_dispatcher` (assigned containers) | gate pass, truck dispatched, picked up, delivered, empty returned |

- The CHA does not record trucking stages (the haulier dispatcher confirms them); change `event_allowed` if the CHA must be able to override.
- Hauliers can read the events of their assigned containers, so what an event may carry is constrained by SHAPE: `payload` accepts only six whitelisted keys with value rules (yard in the three exam yards, result in the four channels, scheduled_at / pickup_window ISO 8601 in UTC `Z`, reference identifier characters only, note <= 140 characters), `evidence_note` <= 200 and `source_ref` <= 100 characters. This stops structure, not meaning: free text is human-entered and visible to hauliers, so nobody should type prices or charges into a note or reference. Messages and documents stay private to the company that received them.
- **Undoing a false event**: an event is never deleted. A `replace` correction supersedes it with a new event; a `void` retracts it (the status falls back to the previous valid stage). The owning CHA may void ANY event on its ledger, including a false trucking event from a haulier that is no longer assigned; every other role may replace or void only what its role may record. A void needs evidence (the reason, which hauliers and clients can read), carries no payload, and cannot itself be voided or replaced. Voiding a replacement hides both the replacement and the original it replaced (the original can only be restored by recording it again). `listEvents` returns void rows too: consumers filter on `correctionKind`. The CHA still cannot record trucking stages.
- **Identity is signed**: the database does not trust `app.company_id` / `app.user_id`. Every request carries a short-lived (60 seconds) HMAC-signed actor token minted by the application with `ACTOR_CONTEXT_SECRET` (after it has a connection) and verified by the database against a key the application role cannot read; the app checks right away that the database accepted it and raises `ActorContextError` otherwise (wrong or rotated key, expiry, clock skew), instead of returning empty results. A grantee who learns a CHA's company or user ids (they are visible to grantees) still cannot act as it. Everything downstream of the token (role lookup, correction scope) uses schema-qualified names and a pinned `search_path`, and the application role has no `TEMPORARY` privilege, so a temp table cannot shadow `users` or `events`. Pooled connections are `DISCARD ALL`ed and a connection whose rollback or discard fails is destroyed.
  - Operations: a token is not bound to a connection, so a captured one is replayable for its 60 seconds, yielding only the caller's own identity (grants and roles are read live). Statement or parameter logging on the database would record tokens: keep it off. Rotating the key takes effect immediately and has no overlap window: run migrate -> `pnpm set-actor-key` (new `ACTOR_CONTEXT_SECRET`) -> restart the app; until the restart all access is refused. App and database clocks must agree within the token life or every request fails with `ActorContextError`. `set-actor-key` refuses the repo-known test secret. `actor_key` and `schema_migrations` are infrastructure tables without `company_id` (and `actor_key` has row-level security with no policy).
- Commercial data (freight, demurrage estimates, tariffs, pricing) must live in tables whose policies require `cha_ops` or `client`; hauliers never match.

## 3. Status chain (fixed, do not add statuses)
vessel discharged -> DO received -> CusDec lodged -> channel assigned -> (exam, if selected) -> release / delivery advice -> gate pass -> truck dispatched -> picked up -> delivered -> empty returned

- Exam is an optional event recorded when the channel requires physical inspection. It carries the exam yard (RCT, Grayline 1, Grayline 2) and, later, a result. It is skipped on green channel.
- Current status is derived from the append-only event ledger. A status is never edited; a correction is a new event referencing the event it corrects.
- Every event records `source` (person or system) and `evidence` (message id, document id, or manual entry).
- Every event also records `confirmed_by_user_id`: the logged-in user who confirmed the suggestion (set by the database, never supplied by the caller). `source` is the reporter (driver, intake, staff); a system source never confirms on its own.

## 4. Cargo model
- **Consignment identity**: a container record is one consignment, unique per (company, container number, bill of lading). A recycled container number simply appears again with a different BL.
- **FCL**: one container, one consignee, one status chain.
- **LCL (full support, decided)**: modelled as several rows sharing a container number, each with its own BL and its own status chain. Which trucking stages are shared by the whole physical container is still undecided (see open questions).
- **Cost note**: full LCL roughly doubles the data model and the board UI. If the pilot slips, LCL is the first thing to defer.

## 5. Deadlines and demurrage
- Track and display: DO valid-until, free storage until, detention/demurrage start.
- Warn when a deadline is within a configurable window or overdue.
- Estimate demurrage/storage cost from tariff rates entered by `cha_ops` (decided). Rates are data, not code. The estimate is labelled an estimate and is visible to `cha_ops` and the `client` the container is shared with, never to hauliers.

## 6. Message and document flows
Intake channels:
1. **Pilot start**: staff paste message text or upload documents into the web app.
2. **After the flow is proven**: WhatsApp Business API inbound (forwarded messages, documents, driver reports) to one number. The Intake module is channel-agnostic so WhatsApp is an adapter, not a rewrite.

Flow (all channels):
1. Raw message/document stored (Message / Document tables) with `company_id`.
2. Intake calls Claude with structured output and returns a **suggested event** with per-field confidence.
3. A permitted person reviews and confirms or edits every extracted field. Only then is an event appended.
4. Container numbers are validated with the ISO 6346 check digit; invalid numbers are rejected and flagged, never saved.
5. Languages: English, Sinhala, Tamil, and Romanised Sinhala messages must be handled by extraction. UI is `en`, `si`, `ta`.

Who sends what (typical):
- CHA ops: DO, CusDec summary, channel result, delivery advice.
- Client: DO or shipping line mail, delivery address.
- Driver: "reached gate", "loaded", "delivered", "empty returned" style messages.

### Intake rules (implemented, `src/intake`)
- The raw message or document is stored first as company-private, append-only evidence. Claude (structured output) proposes a **suggestion**: document type, one status from the fixed chain, and the fields below. Nothing is written to the ledger by extraction.
- Trusted code then checks the model's answer, and does not rely on the model to report problems. It scans the source text itself for container-shaped tokens (4 letters ending U/J/Z, 7 digits, at most one space or hyphen per gap, standing alone): if **any** token fails the ISO 6346 check digit the suggestion is **rejected** and can never be confirmed, even if the model reported nothing; several different valid numbers need a human to pick. The container number and the B/L number must appear in the text as whole tokens; vessel, voyage and dates that the text does not contain are flagged. The status must be in the chain, dates must be real and 2000 or later (Colombo +05:30 assumed when no offset), channel and exam yard must be in their closed lists. Anything dropped or flagged needs a human look (`needs_review`). The text is escaped (`<`, `>`) before it is placed in the delimited data block.
- A suggestion becomes an event only through `confirmSuggestion`: the person supplies a non-empty value for **every** extracted field (a missing, null or blank value is not an acknowledgement; unknown keys are refused; edits are re-validated), gives an event time between 2000 and one year ahead if the text has none, and the acting user is recorded as confirmer. Source is `system / intake`; the role permission matrix still applies; confirming the same evidence for the same event twice is refused.
- Fields: container_no, bl_no, vessel, voyage, consignee, importer, cha, do_date, do_valid_until, freight_paid, channel, advice_issued_at, storage_free_until, cusdec_registered_at, exam_location, exam_scheduled_at. The ledger payload keeps only keys and values the payload rules accept (reference = BL if it is identifier-like, result = channel, yard, scheduled_at in UTC); any extracted value the ledger would refuse (a B/L with spaces, say) is left out of the payload, though it stays on the container.
- Only synthetic fixtures are ever sent to the API. Real documents wait for the PDPA review.
- `pnpm eval:intake` scores extraction against `fixtures/labels.json` (read-only ground truth, SHA-256 pinned in a test; a custom labels file must live in `fixtures/`). It aborts, rather than reporting 0%, if the API call itself fails; an item that expects no event passes only if it is rejected for the invalid container; the report title says `DRY RUN - NOT MODEL RESULTS` or `REAL RUN <model>`.
- Persisted suggestions (migration 0011, `src/intake/store.ts`): every suggestion is stored (immutable) with its evidence, and a decision (`confirmed` or `rejected`) is stored once per suggestion (`UNIQUE (suggestion_id)`). `confirmSuggestionById` loads status, evidence and extracted fields from the database (the caller supplies only the person's values), re-checks that the container number is a whole token in the stored evidence text, then writes the event and the decision in one transaction, so two simultaneous confirms produce one event. The duplicate guard on the evidence itself is still a check-then-insert (not a unique index, so that a void can release the evidence); the unique decision is what closes the by-id path.
- The duplicate guard follows the correction chain: a replaced event keeps consuming its evidence, only a chain that ends in a void releases it (so confirm, void, confirm again works; confirm, replace with manual evidence, confirm again does not).
- Failed or absent extraction (no API key, a refusal): the inbox shows the item as failed and the person uses **manual entry** (`recordManualEvent`): container, stage, time and a reason kept as the event's manual evidence, under the same role rules.

## 7. Notifications (outbound, behind an interface, stubbed in the pilot)
Providers: WhatsApp, email, SMS fallback. A fake provider is used in tests; a logging provider (redacted line, nothing sent) is wired in the app. Templates exist in en/si/ta.
- Haulier: job assigned / cleared to collect (released).
- Client: status-change updates on key changes (channel assigned, released, delivered, empty returned).
- Ops: reminder when suggestions sit unconfirmed (counts only).
- Ops: deadline warnings (DO expiry, storage ending, estimated demurrage). **Not built**: needs the deadline and demurrage model of section 5.

Implemented (migration 0012, `src/notify`):
- `user_contacts` (WhatsApp, email, SMS, language; insert-only; a user adds their own, a CHA its own staff). A CHA can read the contacts of companies it currently shares a container with, nobody else's.
- `notifications` is an outbox of immutable rows: kind, recipient (own company or a current grantee), `event_id` and parameters restricted by the database to a container number, a chain status and a count. Nothing commercial can be put in a notification. `notification_attempts` is an append-only log (round, channel, sent / failed / skipped, provider reference, error up to 200 characters).
- `notifyAfterEvent` queues what an ordinary event calls for and is **run by the owning CHA** (only it can read its grantees' contacts): a haulier recording `delivered` is announced to the client by the CHA-side sweep `notifyPendingEvents` (the board's "send notifications" button runs it), idempotent per (event, recipient, kind). Corrections and voids are not announced.
- `dispatchPending` tries WhatsApp, then email, then SMS using only channels the recipient has an address for and a provider exists for, in the recipient's language, logging each attempt. Rounds are limited (default 3). `skipped` (nothing usable) is final. Providers run inside the caller's transaction, which is fine for stubs: move sending out of the transaction before adding a real provider and a worker (pg-boss).
- Free text in events (`note`, evidence notes) is visible to hauliers on the events they can read: never enter prices or charges there.
- Ops: reminder when suggested events sit unconfirmed too long.

## 8. Screens
Implemented in `app/` (Next.js App Router, React 19). Every server action runs through `withActor`; the signed session cookie (`src/web/session.ts`) only says who, the role is read from the database.
1. **Board** (all roles): containers grouped by current status in chain order, **age in the current status** (from the stage event's time), and the **evidence of the last change** (type, source, who recorded it, and the message or document excerpt only where the viewer's own company holds that evidence: row-level security decides). Hauliers see no B/L number. Deadline badges: not built (needs section 5).
2. **Container detail**: the full timeline with time spent in each status; replaced and voided events are shown struck through, never hidden. Linked documents, LCL shipments, deadlines and the estimate: not built.
3. **Intake inbox**: paste text, get a suggestion, check every extracted field, **one tap to confirm** (status, time and fields are prefilled; the time defaults to now when the text gave none); reject with a reason; manual entry. The confirm form lists only the stages the viewer's role may record.
4. **Haulier jobs**: assigned jobs only - container no., pickup window, terminal/yard, gate pass status, clearance status, importer contact and delivery address. No commercial data.
5. **Settings**: users/roles, tariff rates, deadline warning windows, language.
All user-facing text from `/locales` (`en`, `si`, `ta`; flat dotted keys). A key missing from a locale is a compile error; tests fail on mismatched placeholders, unused keys and literal text in `app/` JSX (lint). **The Sinhala and Tamil strings were written by the assistant and need review by native speakers before any real user sees them.** Dates are stored in UTC and shown in Asia/Colombo; the language is a cookie choice (login page included). The container has no Sinhala or Tamil system fonts, so the browser tests assert text, not rendering; the CSS font stack names Noto Sans Sinhala / Tamil.

**Sign-in is a development picker, not authentication**: it lists the synthetic users written by `pnpm seed:demo` (`.demo-users.json`, gitignored), throws when `NODE_ENV=production`, and takes only a user id from the form (the company id comes from the server's own list). Real authentication (and user deactivation) is required before any real user; the cookie and `getActor()` seam stay. `INTAKE_EXTRACTOR=fake` (a rule-based stand-in, not a model result) is for the browser tests and demos and is refused in production; with neither it nor `ANTHROPIC_API_KEY` set, intake stores a failed suggestion and staff use manual entry.

## 9. Non-functional rules (from CLAUDE.md)
Append-only ledger; `company_id` and row-level security on every table; synthetic fixtures only; humans confirm extraction; UTC storage and Asia/Colombo display; ISO 6346 validation; PDPA obligations reviewed before any real data.

## 10. Out of scope for the pilot (**ASSUMED** - interview answer was blank)
- Customs filing or any ASYCUDA integration.
- Invoicing and payments.
- Live GPS / truck telematics.
- Export workflow (import only).
- Any automatic status change without human confirmation.

## 11. Stack (proposed, owner accepted the default)
TypeScript; Next.js (App Router); PostgreSQL with row-level security; pg-boss job queue on Postgres; Vitest; Playwright; pnpm; Claude API with structured output for extraction.

## 12. Open questions
- Confirm the Section 10 out-of-scope list.
- LCL trucking: a gate pass, dispatch or pickup of one physical LCL container applies to every consignment on it; decide whether a haulier records it once for all rows or per row.
- Authentication and user deactivation (prerequisite before real users); operator-only company onboarding.
- Cross-company evidence visibility (the CHA cannot read a haulier's driver message that an event points at).
- Exam-after-channel and green-channel-skips-exam rules.
- Accepted for the pilot: `seq` gaps are visible to grantees (a hint of overall activity), the same-type cross-party correction rule, `bl_no` is not normalised in the database, concurrent grant/revoke ordering is by insertion not commit, and the actor-token check runs per policy evaluation (fine at pilot size; wrap it in a sub-select if scans get large).
- Demurrage tariff source and who maintains it.
- Prompt 4 leaves open: real authentication (the dev picker is not it), assignment/sharing UI (the demo grants come from the seed), deadline and demurrage warnings, real WhatsApp/email/SMS providers and the pg-boss worker (the dispatcher is a plain function; providers run inside the caller's transaction), WhatsApp inbound, native review of the Sinhala and Tamil strings, and exposing events recorded by a client or haulier to the other parties' contacts (only the owning CHA notifies).
- A valid actor token for a user who is not in the company (a deleted user) passes the post-token check, which covers the company only; every query then returns nothing and the web app signs the user out. Calling `assertProductionSecret` at app start (it only runs in `set-actor-key`) is a hardening follow-up, as is `noInlineConfig` for lint and `ALTER ROLE colombo_app SET search_path`.
- WhatsApp Business API provider and approval timeline.
- Whether `.claude/` (agents, hooks, settings.json) was meant to be in the repo; it was not uploaded.
