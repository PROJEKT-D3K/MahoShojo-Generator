import { useEffect, useState } from 'react';
import { DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE, type TavernPlaceholderPreference } from '@mahoshojo/domain/tavern-card';

export const TAVERN_PLACEHOLDER_PREFERENCE_KEY = 'mahoshojo.tavern.import.placeholder.v1';

function readPreference(): TavernPlaceholderPreference {
  const preference = { ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE };
  try {
    const raw = window.localStorage.getItem(TAVERN_PLACEHOLDER_PREFERENCE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return preference;
    const saved = parsed as Record<string, unknown>;
    if (typeof saved.enabled === 'boolean') preference.enabled = saved.enabled;
    if (typeof saved.userReplacement === 'string') preference.userReplacement = saved.userReplacement;
    if (saved.charReplacementMode === 'auto' || saved.charReplacementMode === 'custom') preference.charReplacementMode = saved.charReplacementMode;
    if (typeof saved.customCharReplacement === 'string') preference.customCharReplacement = saved.customCharReplacement;
  } catch { /* Storage may be absent, denied or malformed; keep the existing defaults. */ }
  return preference;
}

/** Sole owner of the existing page-local preference blob; never persists card content. */
export function useTavernPlaceholderPreference() {
  const [preference, setPreference] = useState<TavernPlaceholderPreference>({ ...DEFAULT_TAVERN_PLACEHOLDER_PREFERENCE });
  const [isHydrated, setIsHydrated] = useState(false);
  useEffect(() => { setPreference(readPreference()); setIsHydrated(true); }, []);
  useEffect(() => {
    if (!isHydrated) return;
    try { window.localStorage.setItem(TAVERN_PLACEHOLDER_PREFERENCE_KEY, JSON.stringify(preference)); }
    catch { /* Restricted storage must not prevent the in-memory import journey. */ }
  }, [isHydrated, preference]);
  return { preference, setPreference, isHydrated };
}
