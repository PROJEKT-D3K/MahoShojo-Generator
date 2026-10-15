import {
  DataCardExpectedOwnerSchema,
  OWNED_RECYCLE_DETAIL_MAX_BYTES,
  OwnedRecycleBinDetailQuerySchema,
  OwnedRecycleBinDetailResponseSchema,
  OwnedRecycleBinPageSchema,
  OwnedRecycleBinQuerySchema,
} from '@mahoshojo/contracts/data-cards';
import type { OwnedRecycleBinReadPort } from '@mahoshojo/ui-web/cloud-save';
import { CARD_LIBRARY_REQUEST_COMMAND, requestCardLibraryRoute } from './card-library-bridge';
import { DesktopCloudError, type InvokeFn } from './cloud-bridge';

const failure = (message: string, code: DesktopCloudError['code'] = 'invalid-response') =>
  new DesktopCloudError(CARD_LIBRARY_REQUEST_COMMAND, code, message);
const aborted = () => new DOMException('回收站读取已取消', 'AbortError');

/** Fixed read-only routes. Aborted/stale IPC results are discarded, never retried or cached. */
export function createDesktopRecycleBinPort(
  invokeFn: InvokeFn,
  expectedUserId: number,
  isCurrent: () => boolean,
): OwnedRecycleBinReadPort {
  const current = () => DataCardExpectedOwnerSchema.safeParse(expectedUserId).success && isCurrent();
  const assertCurrent = (signal: AbortSignal) => {
    if (signal.aborted) throw aborted();
    if (!current()) throw failure('账号会话已改变，请重新打开云端回收站', 'not-authenticated');
  };
  const read = async (
    request: Parameters<typeof requestCardLibraryRoute>[1],
    signal: AbortSignal,
  ) => {
    assertCurrent(signal);
    let onAbort: () => void = () => undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const response = await Promise.race([requestCardLibraryRoute(invokeFn, request), cancelled]);
      assertCurrent(signal);
      if (response.status === 401 || response.status === 409) {
        throw failure('登录状态或账号已改变，请重新打开云端回收站', 'not-authenticated');
      }
      if (response.status === 403) throw failure('当前账号无权读取这条回收站记录', 'forbidden');
      if (response.status === 404 || response.status === 405) {
        throw failure('记录已不存在，或服务端暂不支持安全回收站读取', 'not-found');
      }
      if (response.status !== 200) throw failure(`回收站读取失败（HTTP ${response.status}），请稍后重试`, 'server-unavailable');
      return response.body;
    } catch (cause) {
      assertCurrent(signal);
      if (cause instanceof DesktopCloudError) {
        // Native errors must not accidentally forward transport details or credentials.
        const messages: Partial<Record<DesktopCloudError['code'], string>> = {
          'not-authenticated': '账号会话已失效，请重新打开云端回收站',
          'invalid-request': '回收站查询参数无效，请重新选择',
          'network-error': '网络连接失败，未能读取云端回收站',
          'server-unavailable': '云端回收站暂时不可用，请稍后重试',
          'not-found': '记录已不存在，或服务端暂不支持安全回收站读取',
          forbidden: '当前账号无权读取这条回收站记录',
        };
        throw failure(messages[cause.code] ?? '回收站响应无法验证，请稍后重新读取', cause.code);
      }
      throw failure('云端回收站读取失败，请稍后重试', 'network-error');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  return {
    isCurrent: current,
    async readPage(query, signal) {
      assertCurrent(signal);
      const parsedQuery = OwnedRecycleBinQuerySchema.safeParse({ ...query, expectedUserId });
      if (!parsedQuery.success) throw failure('回收站分页或类型参数无效', 'invalid-request');
      const { limit, offset, type } = parsedQuery.data;
      const body = await read({
        routeId: 'data-cards.recycle.query', expectedUserId,
        query: { limit: String(limit), offset: String(offset), ...(type ? { type } : {}) },
      }, signal);
      const result = OwnedRecycleBinPageSchema.safeParse(body);
      if (!result.success || result.data.ownerUserId !== expectedUserId ||
        result.data.cards.length > limit || result.data.cards.some(card => card.isLegacyQuestionnaire && card.type !== 'character') ||
        result.data.filteredCount < result.data.cards.length ||
        result.data.filteredCount > result.data.total ||
        (result.data.nextOffset !== null && (result.data.nextOffset !== offset + result.data.cards.length ||
          result.data.nextOffset <= offset || result.data.nextOffset >= result.data.filteredCount)) ||
        (type && result.data.cards.some(card => card.type !== type &&
          !(type === 'questionnaire' && card.type === 'character' && card.isLegacyQuestionnaire)))) {
        throw failure('无法确认回收站列表属于当前账号或筛选条件');
      }
      assertCurrent(signal);
      return result.data;
    },
    async readDetail(id, signal) {
      assertCurrent(signal);
      const query = OwnedRecycleBinDetailQuerySchema.safeParse({ expectedUserId, id });
      if (!query.success) throw failure('回收站数据卡 ID 无效', 'invalid-request');
      const body = await read({
        routeId: 'data-cards.recycle-detail.query', expectedUserId, query: { id: query.data.id },
      }, signal);
      const result = OwnedRecycleBinDetailResponseSchema.safeParse(body);
      if (!result.success || result.data.ownerUserId !== expectedUserId || result.data.card.id !== query.data.id ||
        (result.data.card.isLegacyQuestionnaire && result.data.card.type !== 'character') ||
        new TextEncoder().encode(result.data.card.data).byteLength > OWNED_RECYCLE_DETAIL_MAX_BYTES) {
        throw failure('无法确认回收站详情属于当前账号及所选记录');
      }
      assertCurrent(signal);
      return result.data.card;
    },
  };
}
