import { withActor } from '../../src/db/withActor.ts';
import { ROLE_EVENT_TYPES } from '../../src/domain/statusChain.ts';
import { toColomboInput } from '../../src/i18n/format.ts';
import type { MessageKey } from '../../src/i18n/index.ts';
import { listInbox } from '../../src/intake/index.ts';
import type { FieldName, InboxItem } from '../../src/intake/index.ts';
import {
  confirmSuggestionAction,
  manualEntryAction,
  rejectSuggestionAction,
  submitIntakeAction,
} from '../actions.ts';
import { Flash } from '../components/Flash.tsx';
import { Shell } from '../components/Shell.tsx';
import { requireViewer } from '../lib/context.ts';
import type { Viewer } from '../lib/context.ts';

export const dynamic = 'force-dynamic';

const ISSUE_CODES = new Set([
  'assumed_colombo_time', 'extraction_failed', 'invalid_container_no', 'invalid_date', 'invalid_value', 'missing_container_no', 'missing_event_type',
  'multiple_containers', 'ungrounded_bl_no', 'ungrounded_container_no', 'ungrounded_date', 'ungrounded_value', 'unknown_channel', 'unknown_event_type', 'unknown_exam_yard',
]);

function StagePicker({ viewer, selected, name = 'eventType' }: { viewer: Viewer; selected: string | null; name?: string }) {
  const allowed = ROLE_EVENT_TYPES[viewer.role];
  return (
    <select name={name} defaultValue={selected && (allowed as readonly string[]).includes(selected) ? selected : ''} required data-testid="stage">
      <option value="">—</option>
      {allowed.map((s) => (
        <option key={s} value={s}>{viewer.tr(`status.${s}`)}</option>
      ))}
    </select>
  );
}

function Suggestion({ item, viewer, now }: { item: InboxItem; viewer: Viewer; now: Date }) {
  const { tr } = viewer;
  const s = item.suggestion;
  const fieldEntries = Object.entries(s.fields) as Array<[FieldName, string | boolean]>;
  const confirmable = s.status === 'ready' || s.status === 'needs_review';
  const statusKey = `inbox.status_${s.status}` as MessageKey;
  return (
    <article className="card" data-testid="suggestion" data-status={s.status}>
      <div className="row">
        <strong>{tr('inbox.suggested')}</strong>
        <span className="badge" data-testid="suggestion-status">{tr(statusKey)}</span>
      </div>
      <p className="excerpt" aria-label={tr('inbox.original_text')}>{item.excerpt}</p>
      {s.issues.length > 0 ? (
        <ul aria-label={tr('inbox.issues')}>
          {s.issues.map((i, n) => (
            <li key={n} className="muted">{tr((ISSUE_CODES.has(i.code) ? `issue.${i.code}` : 'issue.other') as MessageKey)}{i.field ? ` (${tr(`field.${i.field}`)})` : ''}</li>
          ))}
        </ul>
      ) : null}
      {confirmable ? (
        <form action={confirmSuggestionAction}>
          <input type="hidden" name="id" value={item.id} />
          <div className="fields">
            <div>
              <label>{tr('inbox.status')}</label>
              <StagePicker viewer={viewer} selected={s.eventType} />
            </div>
            <div>
              <label>{tr('inbox.when')}</label>
              <input type="datetime-local" name="occurredAt" required defaultValue={toColomboInput(s.suggestedOccurredAt ?? now)} data-testid="when" />
            </div>
          </div>
          <h2>{tr('inbox.fields')}</h2>
          <div className="fields">
            {fieldEntries.map(([name, value]) => (
              <div key={name}>
                <label>{tr(`field.${name}`)}</label>
                {typeof value === 'boolean' ? (
                  <select name={`field_${name}`} defaultValue={String(value)}>
                    <option value="true">{tr('bool.true')}</option>
                    <option value="false">{tr('bool.false')}</option>
                  </select>
                ) : (
                  <input type="text" name={`field_${name}`} defaultValue={value} required data-testid={`field-${name}`} />
                )}
              </div>
            ))}
          </div>
          {viewer.role === 'cha_ops' ? (
            <label><input type="checkbox" name="createContainer" /> {tr('inbox.create_container')}</label>
          ) : null}
          <div className="actions">
            <button type="submit" className="primary" data-testid="confirm">{tr('inbox.confirm')}</button>
          </div>
        </form>
      ) : null}
      <form action={rejectSuggestionAction} className="actions">
        <input type="hidden" name="id" value={item.id} />
        <input type="text" name="reason" required placeholder={tr('inbox.reject_reason')} aria-label={tr('inbox.reject_reason')} />
        <button type="submit" className="danger" data-testid="reject">{tr('inbox.reject')}</button>
      </form>
    </article>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const { tr } = viewer;
  const now = new Date();
  const items = await withActor(viewer.actor, (c) => listInbox(c));
  return (
    <Shell viewer={viewer} path="/inbox">
      <h1 data-testid="page-title">{tr('inbox.title')}</h1>
      <Flash params={await searchParams} tr={tr} />
      <form action={submitIntakeAction} className="card">
        <label htmlFor="intake-text">{tr('inbox.paste_label')}</label>
        <textarea id="intake-text" name="text" required maxLength={20000} data-testid="intake-text" />
        <div className="actions">
          <button type="submit" className="primary" data-testid="intake-submit">{tr('inbox.paste_submit')}</button>
        </div>
      </form>

      {items.length === 0 ? <p data-testid="inbox-empty">{tr('inbox.empty')}</p> : null}
      {items.map((item) => (
        <Suggestion key={item.id} item={item} viewer={viewer} now={now} />
      ))}

      <h2>{tr('manual.title')}</h2>
      <form action={manualEntryAction} className="card">
        <div className="fields">
          <div>
            <label>{tr('manual.container')}</label>
            <input type="text" name="containerNo" required data-testid="manual-container" />
          </div>
          <div>
            <label>{tr('manual.bl')}</label>
            <input type="text" name="blNo" data-testid="manual-bl" />
          </div>
          <div>
            <label>{tr('manual.stage')}</label>
            <StagePicker viewer={viewer} selected={null} />
          </div>
          <div>
            <label>{tr('manual.when')}</label>
            <input type="datetime-local" name="occurredAt" required defaultValue={toColomboInput(now)} />
          </div>
        </div>
        <label>{tr('manual.reason')}</label>
        <input type="text" name="reason" required maxLength={200} data-testid="manual-reason" />
        {viewer.role === 'cha_ops' ? <label><input type="checkbox" name="createContainer" data-testid="manual-create" /> {tr('inbox.create_container')}</label> : null}
        <div className="actions">
          <button type="submit" className="primary" data-testid="manual-submit">{tr('manual.submit')}</button>
        </div>
      </form>
    </Shell>
  );
}

