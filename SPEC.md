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
- Known limits, deferred to Prompt 4: suggestions are passed in by the caller rather than persisted and confirmed by id (so the server cannot yet re-load status and evidence), and the duplicate-confirmation guard is a check-then-insert without a unique index.

## 7. Notifications (outbound, behind an interface, stubbed in the pilot)
Providers: WhatsApp, email, SMS fallback. A fake provider is used in tests. Templates exist in en/si/ta.
- Haulier: job assigned / cleared to collect (gate pass confirmed or released).
- Client: status-change updates on key changes (channel assigned, released, delivered).
- Ops: deadline warnings (DO expiry, storage ending, estimated demurrage).
- Ops: reminder when suggested events sit unconfirmed too long.

## 8. Screens
1. **Board** (ops/client): containers grouped by current status, age in status, evidence of last change, deadline badges.
2. **Container detail**: full event timeline, linked messages/documents, shipments (LCL), deadlines and estimate.
3. **Intake inbox**: paste/upload; list of suggested events with extracted fields to confirm, edit or reject.
4. **Haulier jobs**: assigned jobs only - container no., pickup window, terminal/yard, gate pass status, clearance status, importer contact and delivery address. No commercial data.
5. **Settings**: users/roles, tariff rates, deadline warning windows, language.
All user-facing text from `/locales`.

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
- WhatsApp Business API provider and approval timeline.
- Whether `.claude/` (agents, hooks, settings.json) was meant to be in the repo; it was not uploaded.
