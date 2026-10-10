import type { ReactNode } from 'react';
import { LOCALES } from '../../src/i18n/index.ts';
import { logoutAction, setLocaleAction } from '../actions.ts';
import type { Viewer } from '../lib/context.ts';

/** Page frame: navigation, who is signed in, the language switcher. All text comes from /locales. */
export function Shell({ viewer, path, children }: { viewer: Viewer; path: string; children: ReactNode }) {
  const { tr } = viewer;
  return (
    <>
      <header className="bar">
        <strong>{tr('app.title')}</strong>
        <nav aria-label={tr('app.title')}>
          <a href="/" aria-current={path === '/' ? 'page' : undefined}>{tr('nav.board')}</a>
          <a href="/inbox" aria-current={path === '/inbox' ? 'page' : undefined}>{tr('nav.inbox')}</a>
        </nav>
        <form action={setLocaleAction} className="langs" aria-label={tr('nav.language')}>
          <input type="hidden" name="returnTo" value={path} />
          {LOCALES.map((l) => (
            <button key={l} name="locale" value={l} data-testid={`lang-${l}`} aria-pressed={viewer.locale === l} type="submit">
              {tr(`locale.${l}`)}
            </button>
          ))}
        </form>
        <span className="who" data-testid="viewer">
          {tr('nav.signed_in_as', { name: viewer.displayName, role: tr(`role.${viewer.role}`), company: viewer.companyName })}
        </span>
        <form action={logoutAction}>
          <button type="submit" data-testid="logout">{tr('nav.logout')}</button>
        </form>
      </header>
      <main>{children}</main>
    </>
  );
}
