'use client';
import { useEffect, useState } from 'react';

// Keep the existing Web preference identity; each host persists in its own origin.
export const MAGIC_TEA_PARTY_SIDEBAR_PREFERENCE_KEY = 'magic-tea-party:session-sidebar-v1';

function readPreference() {
  const defaults = { pinnedCollapsed: false, recentCollapsed: false };
  try {
    const raw = window.localStorage.getItem(MAGIC_TEA_PARTY_SIDEBAR_PREFERENCE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const saved = parsed as Record<string, unknown>;
    return {
      pinnedCollapsed: typeof saved.pinnedCollapsed === 'boolean' ? saved.pinnedCollapsed : false,
      recentCollapsed: typeof saved.recentCollapsed === 'boolean' ? saved.recentCollapsed : false,
    };
  } catch { return defaults; }
}

/** UI-only preferences; session documents and native configuration are untouched. */
export function useSessionSidebarPreference() {
  const [pinnedCollapsed, setPinnedCollapsed] = useState(false);
  const [recentCollapsed, setRecentCollapsed] = useState(false);
  const [restored, setRestored] = useState(false);
  useEffect(() => {
    const saved = readPreference();
    setPinnedCollapsed(saved.pinnedCollapsed);
    setRecentCollapsed(saved.recentCollapsed);
    setRestored(true);
  }, []);
  useEffect(() => {
    if (!restored) return;
    try {
      window.localStorage.setItem(MAGIC_TEA_PARTY_SIDEBAR_PREFERENCE_KEY, JSON.stringify({ pinnedCollapsed, recentCollapsed }));
    } catch { /* Restricted storage must not block in-memory toggling. */ }
  }, [pinnedCollapsed, recentCollapsed, restored]);
  return { pinnedCollapsed, setPinnedCollapsed, recentCollapsed, setRecentCollapsed };
}
