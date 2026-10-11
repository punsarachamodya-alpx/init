import { notFound } from 'next/navigation';
import { loadTimeline } from '../../../src/board/board.ts';
import { withActor } from '../../../src/db/withActor.ts';
import { formatAge, formatColombo } from '../../../src/i18n/format.ts';
import { Shell } from '../../components/Shell.tsx';
import { requireViewer } from '../../lib/context.ts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function ContainerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const { tr, locale } = viewer;
  const data = await withActor(viewer.actor, async (c) => {
    const { rows } = await c.query<{ container_no: string; bl_no: string }>('SELECT container_no, bl_no FROM containers WHERE id = $1', [id]);
    return rows[0] ? { container: rows[0], timeline: await loadTimeline(c, id, new Date()) } : null;
  });
  if (!data) notFound();

  return (
    <Shell viewer={viewer} path={`/containers/${id}`}>
      <p><a href="/">{tr('container.back')}</a></p>
      <h1 data-testid="page-title">{tr('container.title', { container: data.container.container_no })}</h1>
      <h2>{tr('container.timeline')}</h2>
      <ol className="plain" data-testid="timeline">
        {data.timeline.map((e) => (
          <li key={e.eventId} className="card" data-testid={`event-${e.kind}`}>
            <div className={e.kind === 'replaced' || e.kind === 'voided' ? 'row struck' : 'row'}>
              <strong>{tr(`status.${e.eventType}`)}</strong>
              <span>{formatColombo(e.occurredAt, locale)}</span>
              {e.kind === 'live' && e.spentMs !== null ? <span className="badge">{tr('container.spent', { age: formatAge(e.spentMs, locale) })}</span> : null}
            </div>
            <div className="muted">
              {tr(`evidence.${e.evidence.kind}`)} · {tr(`source.${e.source.type}`)} ({e.source.ref}) ·{' '}
              {e.recordedByOwnCompany ? tr('board.recorded_by_own') : tr('board.recorded_by_other')} · {tr('container.recorded_at', { time: formatColombo(e.recordedAt, locale) })}
              {e.kind === 'replaced' ? <> · {tr('container.replaced')}</> : null}
              {e.kind === 'voided' ? <> · {tr('container.voided')}</> : null}
              {e.kind === 'void_row' ? <> · {tr('container.void_row')}</> : null}
            </div>
            {e.evidence.note ? <p className="excerpt">{e.evidence.note}</p> : null}
            {e.evidence.excerpt ? <p className="excerpt">{e.evidence.excerpt}</p> : null}
          </li>
        ))}
      </ol>
    </Shell>
  );
}
