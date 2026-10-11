import { redirect } from 'next/navigation';
import { LOCALES } from '../../src/i18n/index.ts';
import { loadDemoUsers } from '../../src/web/demoUsers.ts';
import { loginAction, setLocaleAction } from '../actions.ts';
import { getLocale, getViewer, translator } from '../lib/context.ts';

export const dynamic = 'force-dynamic';

export default async function LoginPage() {
  // Only a cookie whose user still exists skips the picker: a stale cookie must not bounce between / and /login.
  if (await getViewer()) redirect('/');
  const locale = await getLocale();
  const tr = translator(locale);
  const users = loadDemoUsers(); // throws in production: the picker is a development convenience
  return (
    <main>
      <form action={setLocaleAction} className="langs">
        <input type="hidden" name="returnTo" value="/login" />
        {LOCALES.map((l) => (
          <button key={l} name="locale" value={l} data-testid={`lang-${l}`} aria-pressed={locale === l} type="submit">
            {tr(`locale.${l}`)}
          </button>
        ))}
      </form>
      <h1 data-testid="page-title">{tr('login.title')}</h1>
      <p className="muted">{tr('login.intro')}</p>
      {users.length === 0 ? <p>{tr('login.none')}</p> : null}
      <ul className="plain">
        {users.map((u) => (
          <li key={u.userId} className="card">
            <form action={loginAction} className="row">
              <input type="hidden" name="userId" value={u.userId} />
              <strong>{u.label}</strong>
              <span className="muted">{tr(`role.${u.role}`)} · {u.companyName}</span>
              <button type="submit" data-testid={`login-${u.label}`}>{tr('login.sign_in')}</button>
            </form>
          </li>
        ))}
      </ul>
    </main>
  );
}
