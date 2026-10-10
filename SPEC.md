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
- Hauliers can read the events of their assigned containers, so event `payload` accepts only whitelisted non-commercial keys. Messages and documents stay private to the company that received them.
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
- Trusted code then checks the model's answer: the container number must pass the ISO 6346 check digit (otherwise the suggestion is **rejected** and can never be confirmed), must literally appear in the source text, the status must be in the chain, dates must be real (Colombo +05:30 assumed when no offset), and channel / exam yard must be in their closed lists. Anything dropped needs a human look (`needs_review`).
- A suggestion becomes an event only through `confirmSuggestion`: the person supplies a value for **every** extracted field (edits are re-validated), says when it happened if the text does not, and the acting user is recorded as confirmer. Source is `system / intake`; the role permission matrix still applies; confirming the same evidence for the same event twice is refused.
- Fields: container_no, bl_no, vessel, voyage, consignee, importer, cha, do_date, do_valid_until, freight_paid, channel, advice_issued_at, storage_free_until, cusdec_registered_at, exam_location, exam_scheduled_at. The ledger payload keeps only non-commercial keys (reference = BL, result = channel, yard, scheduled_at).
- Only synthetic fixtures are ever sent to the API. Real documents wait for the PDPA review.
- `pnpm eval:intake` scores extraction against `fixtures/labels.json` (read-only ground truth). Suggestions are not persisted yet; the inbox (Prompt 4) adds that.

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
- Retracting a mistaken event (void correction); exam-after-channel and yard rules.
- Demurrage tariff source and who maintains it.
- WhatsApp Business API provider and approval timeline.
- Whether `.claude/` (agents, hooks, settings.json) was meant to be in the repo; it was not uploaded.
