import { OwnedDataCardDeletionPreviewQuerySchema, OwnedDataCardRestoreRequestSchema } from '@mahoshojo/contracts/data-cards';
import { getOwnedCardRestoreNotice, type OwnedCardRestorePort, type RestoreResponse } from '@mahoshojo/ui-web/cloud-save';
import { authStorage } from './auth';
import type { AuthIdentity } from './auth-identity';

export function createWebOwnedCardRestorePort(expectedUserId: number, identity: AuthIdentity, options: Pick<OwnedCardRestorePort, 'isBlocked' | 'onBusyChange' | 'onChanged'> = {}): OwnedCardRestorePort {
  const request = async (path: string, method: 'GET' | 'POST', body: unknown, signal: AbortSignal): Promise<RestoreResponse> => {
    if (signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变');
    const auth = await authStorage.getAuth();
    if ((auth !== null && auth.userId !== expectedUserId) || signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变');
    const key = auth?.authKey?.trim();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(abort, 30_000);
    try {
      const response = await fetch(path, { method, headers: { ...(key ? { Authorization: `Bearer ${key}` } : {}), ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) },
        ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal });
      const reader = response.body?.getReader(); if (!reader) throw new Error('响应无法核对');
      const chunks: Uint8Array[] = []; let size = 0;
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.byteLength;
          if (size > 128 * 1024 || signal.aborted || !identity.isCurrent()) throw new Error('响应无法核对');
          chunks.push(part.value);
        }
      } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
      finally { reader.releaseLock(); }
      if (signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变');
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      let parsed: unknown = null;
      try { parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { /* A malformed success remains unknown in the shared verifier. */ }
      return { status: response.status, body: parsed };
    } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); controller.abort(); }
  };
  return {
    ...options, expectedUserId, isCurrent: identity.isCurrent, notice: getOwnedCardRestoreNotice(identity, identity.epoch, expectedUserId),
    preview(id, signal) {
      const query = OwnedDataCardDeletionPreviewQuerySchema.parse({ expectedUserId, scope: 'recycle', id });
      return request(`/api/data-cards/delete-preview-owned?${new URLSearchParams({ expectedUserId: String(query.expectedUserId), scope: query.scope, id })}`, 'GET', undefined, signal);
    },
    write(target, signal) {
      const payload = OwnedDataCardRestoreRequestSchema.parse({ expectedUserId, ...target });
      return request('/api/data-cards/restore-owned', 'POST', payload, signal);
    },
  };
}
