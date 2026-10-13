'use client';

import type { ReactNode } from 'react';

export type MagicTeaPartyPageViewProps = {
  hero: ReactNode;
  sidebar: ReactNode;
  setup: ReactNode;
  beforeChat?: ReactNode;
  chat: ReactNode;
  afterChat?: ReactNode;
  footer?: ReactNode;
  modals?: ReactNode;
};

export function MagicTeaPartyPageView({ hero, sidebar, setup, beforeChat, chat, afterChat, footer, modals }: MagicTeaPartyPageViewProps) {
  return (
    <div className="magic-background-white">
      <div className="container !max-w-[1200px]">
        <div className="card !max-w-none">
          {hero}
          <div className="mt-6 grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
            {sidebar}
            <main className="space-y-4 min-w-0">
              {setup}
              {beforeChat}
              <div className="rounded-xl border border-pink-100 bg-white p-4">{chat}</div>
              {afterChat}
              {footer}
            </main>
          </div>
        </div>
      </div>
      {modals}
    </div>
  );
}
