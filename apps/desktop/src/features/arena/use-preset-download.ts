import { useEffect, useRef, useState } from 'react';
import type { Preset } from '@mahoshojo/domain/presets';
import { downloadTextFile } from '../../platform/download-text-file';
import { fetchArenaPreset } from './input';

export function useArenaPresetDownload() {
  const flight = useRef<AbortController | null>(null);
  const [downloading, setDownloading] = useState(false);
  const [feedback, setFeedback] = useState<{ kind: 'started' | 'error'; message: string } | null>(null);
  useEffect(() => () => { flight.current?.abort(); flight.current = null; }, []);

  const download = async (preset: Preset) => {
    if (flight.current) return;
    const controller = new AbortController(); flight.current = controller;
    setDownloading(true); setFeedback(null);
    try {
      // 只读内置白名单原件，不导入草稿，也不重新序列化或移除签名/扩展字段。
      const text = await fetchArenaPreset('character', preset.filename, controller.signal);
      if (controller.signal.aborted || flight.current !== controller) return;
      downloadTextFile(preset.filename, text, 'application/json');
      setFeedback({ kind: 'started', message: `已发起“${preset.name}”预设下载，请在系统下载提示中确认保存。` });
    } catch (cause) {
      if (!controller.signal.aborted && flight.current === controller) setFeedback({ kind: 'error', message: cause instanceof Error ? cause.message : '预设下载未能发起，请重试。' });
    } finally {
      if (flight.current === controller) { flight.current = null; setDownloading(false); }
    }
  };
  return { download, downloading, feedback };
}
