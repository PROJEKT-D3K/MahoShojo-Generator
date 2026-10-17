/** A failed chunk may be a transient network error or a URL from an older deployment. */
export function isDeferredChunkError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const { name, message } = error as { name?: unknown; message?: unknown };
  return name === 'ChunkLoadError'
    || (typeof message === 'string' && /ChunkLoadError|Loading (?:CSS )?chunk [\s\S]*failed|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i.test(message));
}

/** Retry only module transport failures. Re-importing cannot change an old webpack chunk URL. */
export async function loadDeferredModule<Module>(load: () => Promise<Module>): Promise<Module> {
  const delays = [300, 900];
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await load();
    } catch (error) {
      if (!isDeferredChunkError(error) || attempt >= delays.length) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delays[attempt]));
    }
  }
}

/** Share an attempt (including its retry budget) across consumers; a failed attempt can be retried explicitly. */
export function createDeferredModuleLoader<Module>(load: () => Promise<Module>): () => Promise<Module> {
  let pending: Promise<Module> | undefined;
  return () => {
    if (!pending) {
      pending = loadDeferredModule(load).catch((error: unknown) => {
        pending = undefined;
        throw error;
      });
    }
    return pending;
  };
}

export function confirmDeferredPageReload(reload = () => window.location.reload()): void {
  if (window.confirm('刷新会中断正在进行的生成或多人会话，并可能丢失尚未保存的输入。请先停止或等待任务完成，并导出需要保留的内容。确认现在刷新？')) {
    reload();
  }
}
