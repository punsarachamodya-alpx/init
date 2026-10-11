import { loadBoard } from '../src/board/board.ts';
import type { BoardRow } from '../src/board/board.ts';
import { withActor } from '../src/db/withActor.ts';
import { EVENT_TYPES } from '../src/domain/statusChain.ts';
import type { EventType } from '../src/domain/statusChain.ts';
import { formatAge, formatColombo } from '../src/i18n/format.ts';
import { sendNotificationsAction } from './actions.ts';
import { Flash } from './components/Flash.tsx';
import { Shell } from './components/Shell.tsx';
import { requireViewer } from './lib/context.ts';

export const dynamic = 'force-dynamic';

export default async function BoardPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const viewer = await requireViewer();
  const { tr, locale } = viewer;
  const now = new Date();
  const rows = await withActor(viewer.actor, (c) => loadBoard(c, now));

  const groups: Array<{ key: string; label: string; rows: BoardRow[] }> = [];
  const none = rows.filter((r) => r.status === null);
  if (none.length > 0) groups.push({ key: 'none', label: tr('board.no_status'), rows: none });
  for (const s of EVENT_TYPES as readonly EventType[]) {
    const inGroup = rows.filter((r) => r.status === s);
    if (inGroup.length > 0) groups.push({ key: s, label: tr(`status.${s}`), rows: inGroup });
  }

  return (
    <Shell viewer={viewer} path="/">
      <h1 data-testid="page-title">{tr('board.title')}</h1>
      <Flash params={await searchParams} tr={tr} />
      {viewer.role === 'cha_ops' ? (
        <form action={sendNotificationsAction}>
          <button type="submit" data-testid="send-notifications">{tr('board.send_notifications')}</button>
        </form>
      ) : null}
      {rows.length === 0 ? <p data-testid="board-empty">{tr('board.empty')}</p> : null}
      {groups.map((g) => (
        <section key={g.key} className="group" data-testid={`board-group-${g.key}`}>
          <h2>{tr('board.group_heading', { status: g.label, count: g.rows.length })}</h2>
          {g.rows.map((r) => (
            <article key={r.containerId} className="card" data-testid={`container-${r.containerNo}`}>
              <div className="row">
                <a className="no" href={`/containers/${r.containerId}`}>{r.containerNo}</a>
                <span className="muted">{tr(`cargo.${r.cargoType}`)}</span>
                {r.blNo ? <span className="muted">{tr('board.bl', { bl: r.blNo })}</span> : null}
                {r.ageMs !== null && r.statusSince ? (
                  <span className="badge" data-testid={`age-${r.containerNo}`} title={tr('board.since', { time: formatColombo(r.statusSince, locale) })}>
                    {tr('board.age', { age: formatAge(r.ageMs, locale) })}
                  </span>
                ) : null}
              </div>
              {r.lastChange ? (
                <div className="muted" data-testid={`evidence-${r.containerNo}`}>
                  {tr('board.last_change')}: {tr(`evidence.${r.lastChange.evidence.kind}`)} · {tr(`source.${r.lastChange.source.type}`)} ({r.lastChange.source.ref}) ·{' '}
                  {r.lastChange.recordedByOwnCompany ? tr('board.recorded_by_own') : tr('board.recorded_by_other')} · {formatColombo(r.lastChange.recordedAt, locale)}
                  {r.lastChange.evidence.note ? <p className="excerpt">{r.lastChange.evidence.note}</p> : null}
                  {r.lastChange.evidence.excerpt ? <p className="excerpt">{r.lastChange.evidence.excerpt}</p> : null}
                </div>
              ) : null}
            </article>
          ))}
        </section>
      ))}
    </Shell>
  );
}
