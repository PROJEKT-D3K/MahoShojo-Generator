'use client';

import type { ReactNode } from 'react';

export type MagicTeaPartyHeroProps = {
  globalError: string | null;
  description: ReactNode;
  homeLink: ReactNode;
  renderError?: (message: string) => ReactNode;
};

export function MagicTeaPartyHero({ globalError, description, homeLink, renderError }: MagicTeaPartyHeroProps) {
  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-pink-800">魔法茶会</h1>
          <p className="mt-1 text-sm text-gray-600">{description}</p>
        </div>
        {homeLink}
      </div>

      {globalError ? (
        <div className="mt-4">
          {renderError ? renderError(globalError) : <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{globalError}</div>}
        </div>
      ) : null}
    </>
  );
}
