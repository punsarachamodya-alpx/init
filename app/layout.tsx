import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import './globals.css';
import { getLocale, translator } from './lib/context.ts';

export async function generateMetadata(): Promise<Metadata> {
  return { title: translator(await getLocale())('app.title') };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
