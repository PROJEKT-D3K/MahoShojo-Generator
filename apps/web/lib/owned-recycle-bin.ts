import { OwnedRecycleBinPageSchema, OwnedRecycleBinDetailResponseSchema, type OwnedRecycleBinPage } from '@mahoshojo/contracts/data-cards';
import type { OwnedRecycleBinReadPort } from '@mahoshojo/ui-web/cloud-save';
import { authStorage } from './auth';
import type { AuthIdentity } from './auth-identity';

/** 只读请求冻结账号，使用已有凭据或 Cookie，不触发旧 helper 的登录自愈。 */
export function createWebRecycleBinPort(expectedUserId: number, identity: AuthIdentity): OwnedRecycleBinReadPort {
  const request = async (path: string, query: Record<string, string>, signal: AbortSignal, maxBytes: number) => {
    if (signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变，请重新打开云端回收站');
    const auth = await authStorage.getAuth();
    const authKey = typeof auth?.authKey === 'string' ? auth.authKey.trim() : '';
    const authorization = authKey ? `Bearer ${authKey}` : null;
    if ((auth !== null && auth.userId !== expectedUserId) || signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变，请重新打开云端回收站');
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal.addEventListener('abort', cancel, { once: true });
    const timeout = setTimeout(cancel, 30_000);
    try {
    const response = await fetch(`${path}?${new URLSearchParams({ ...query, expectedUserId: String(expectedUserId) })}`, {
      headers: authorization ? { Authorization: authorization } : {}, credentials: 'same-origin', redirect: 'error', cache: 'no-store', signal: controller.signal,
    });
    if (!identity.isCurrent() || signal.aborted) throw new Error('登录状态已改变，请重新打开云端回收站');
    if (!response.ok) throw new Error(response.status === 401 ? '登录已失效，请重新登录后打开云端回收站'
      : response.status === 409 ? '登录账号已改变，请重新打开云端回收站'
      : response.status === 404 || response.status === 405 ? '回收站或数据卡暂不可用，请刷新或等待服务更新' : '读取云端回收站失败，请稍后重试');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('云端回收站响应无效，请重试');
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        size += part.value.byteLength;
        if (size > maxBytes) throw new Error('云端回收站响应过大，请重试');
        if (signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变，请重新打开云端回收站');
        chunks.push(part.value);
      }
    } catch (cause) { await reader.cancel().catch(() => {}); throw cause; }
    finally { reader.releaseLock(); }
    const bytes = new Uint8Array(size); let cursor = 0;
    for (const chunk of chunks) { bytes.set(chunk, cursor); cursor += chunk.byteLength; }
    if (signal.aborted || !identity.isCurrent()) throw new Error('登录状态已改变，请重新打开云端回收站');
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown; }
    catch { throw new Error('云端回收站响应无效，请重试'); }
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', cancel); controller.abort(); }
  };
  return {
    isCurrent: identity.isCurrent,
    async readPage(query, signal) {
      const raw = await request('/api/data-cards/recycle-owned', { limit: String(query.limit), offset: String(query.offset), ...(query.type ? { type: query.type } : {}) }, signal, 4 * 1024 * 1024);
      const parsed = OwnedRecycleBinPageSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerUserId !== expectedUserId || parsed.data.cards.length > query.limit ||
        parsed.data.cards.some((card) => card.isLegacyQuestionnaire && card.type !== 'character') ||
        (query.type && parsed.data.cards.some((card) => card.type !== query.type && !(query.type === 'questionnaire' && card.type === 'character' && card.isLegacyQuestionnaire)))) {
        throw new Error('无法确认当前账号的回收站，请刷新重试');
      }
      const page: OwnedRecycleBinPage = parsed.data;
      if (page.filteredCount > page.total || page.cards.length > page.filteredCount || (page.nextOffset !== null && (page.nextOffset !== query.offset + page.cards.length || page.nextOffset <= query.offset || page.nextOffset >= page.filteredCount))) throw new Error('回收站分页已变化，请刷新重试');
      return page;
    },
    async readDetail(id, signal) {
      const raw = await request('/api/data-cards/recycle-owned/detail', { id }, signal, 8 * 1024 * 1024);
      const parsed = OwnedRecycleBinDetailResponseSchema.safeParse(raw);
      if (!parsed.success || parsed.data.ownerUserId !== expectedUserId || parsed.data.card.id !== id ||
        (parsed.data.card.isLegacyQuestionnaire && parsed.data.card.type !== 'character')) throw new Error('无法确认这张回收站数据卡，请刷新重试');
      return parsed.data.card;
    },
  };
}
