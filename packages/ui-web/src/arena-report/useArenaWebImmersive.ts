'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useEscapeLayer } from '../modal/escape-stack';

/** DOM fullscreen adapter. Native isolated windows keep their own adapter and never call this from untrusted content. */
export function useArenaWebImmersive({ active }: { active: boolean }) {
  const [immersive, setImmersive] = useState(false);
  const fullscreenViewer = useRef<HTMLDivElement | null>(null);
  const requestEpoch = useRef(0);
  const mounted = useRef(false);
  const exitImmersive = useCallback(() => {
    requestEpoch.current += 1;
    setImmersive(false);
    const viewer = fullscreenViewer.current;
    fullscreenViewer.current = null;
    if (viewer && document.fullscreenElement === viewer && document.exitFullscreen) {
      void document.exitFullscreen().catch(() => undefined);
    }
  }, []);
  const enterImmersive = useCallback((viewer: HTMLDivElement | null) => {
    if (!active) return;
    setImmersive(true);
    if (!viewer || typeof viewer.requestFullscreen !== 'function' || fullscreenViewer.current === viewer) return;
    const epoch = ++requestEpoch.current;
    fullscreenViewer.current = viewer;
    void viewer.requestFullscreen().then(() => {
      // A pending browser request may settle after switching results or unmounting.
      if ((epoch !== requestEpoch.current || !mounted.current) && fullscreenViewer.current !== viewer) {
        if (document.fullscreenElement === viewer && document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
      }
    }).catch(() => { if (epoch === requestEpoch.current) fullscreenViewer.current = null; });
  }, [active]);

  useEffect(() => {
    mounted.current = true;
    const onFullscreenChange = () => {
      if (fullscreenViewer.current && document.fullscreenElement !== fullscreenViewer.current) exitImmersive();
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => {
      mounted.current = false;
      requestEpoch.current += 1;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      const viewer = fullscreenViewer.current;
      fullscreenViewer.current = null;
      if (viewer && document.fullscreenElement === viewer && document.exitFullscreen) void document.exitFullscreen().catch(() => undefined);
    };
  }, [exitImmersive]);
  useEffect(() => {
    if (immersive && !active) exitImmersive();
  }, [active, immersive, exitImmersive]);
  useEffect(() => {
    if (!immersive) return;
    const previousBody = document.body.style.overflow;
    const previousRoot = document.documentElement.style.overflow;
    document.body.style.overflow = 'hidden';
    document.documentElement.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previousBody; document.documentElement.style.overflow = previousRoot; };
  }, [immersive]);
  useEscapeLayer({ active: immersive, onEscape: () => {
    if (fullscreenViewer.current && document.fullscreenElement === fullscreenViewer.current) return 'browser';
    exitImmersive();
    return true;
  } });
  return { immersive, enterImmersive, exitImmersive };
}
