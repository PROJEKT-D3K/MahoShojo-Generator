import { DataCardExpectedOwnerSchema, OwnedDataCardDeletionPreviewQuerySchema, OwnedDataCardRestoreRequestSchema, OwnedDataCardRestoreAcknowledgementSchema } from '@mahoshojo/contracts/data-cards';
import type { OwnedCardRestorePort } from '@mahoshojo/ui-web/cloud-save';
import { CARD_LIBRARY_REQUEST_COMMAND, requestCardLibraryRoute } from './card-library-bridge';
import { DesktopCloudError, type InvokeFn } from './cloud-bridge';

const aborted = () => new DOMException('已停止等待恢复结果；服务器可能已执行', 'AbortError');

/** Fixed Native routes only. Aborting stops waiting, never rolls back or replays a write. */
export function createDesktopOwnedCardRestorePort(
  invokeFn: InvokeFn, expectedUserId: number, isCurrent: () => boolean,
  options: Pick<OwnedCardRestorePort, 'isBlocked' | 'onBusyChange' | 'onChanged' | 'notice'> = {},
): OwnedCardRestorePort {
  const current = () => DataCardExpectedOwnerSchema.safeParse(expectedUserId).success && isCurrent();
  const assertCurrent = (signal: AbortSignal) => {
    if (signal.aborted) throw aborted();
    if (!current()) throw new Error('账号会话已改变');
  };
  const run = async (request: Parameters<typeof requestCardLibraryRoute>[1], signal: AbortSignal) => {
    assertCurrent(signal);
    let onAbort: () => void = () => undefined;
    try {
      const cancelled = new Promise<never>((_, reject) => {
        onAbort = () => reject(aborted());
        signal.addEventListener('abort', onAbort, { once: true });
      });
      const response = await Promise.race([requestCardLibraryRoute(invokeFn, request), cancelled]);
      assertCurrent(signal);
      return response;
    } catch (cause) {
      assertCurrent(signal);
      const code = cause instanceof DesktopCloudError ? cause.code : 'network-error';
      throw new DesktopCloudError(CARD_LIBRARY_REQUEST_COMMAND, code,
        code === 'network-error' ? '网络连接失败，恢复结果无法确认' : '恢复响应无法验证，请刷新核对');
    } finally {
      signal.removeEventListener('abort', onAbort);
    }
  };
  return {
    ...options, expectedUserId, isCurrent: current,
    async preview(id, signal) {
      const query = OwnedDataCardDeletionPreviewQuerySchema.parse({ expectedUserId, scope: 'recycle', id });
      return run({ routeId: 'data-cards.delete-preview.query', expectedUserId, query: { scope: 'recycle', id: query.id! } }, signal);
    },
    async write(input, signal) {
      const body = OwnedDataCardRestoreRequestSchema.parse({ ...input, expectedUserId });
      const response = await run({ routeId: 'data-cards.restore', expectedUserId, body }, signal);
      if (response.status >= 200 && response.status < 300) {
        const ack = OwnedDataCardRestoreAcknowledgementSchema.safeParse(response.body);
        if (response.status !== 200 || !ack.success || ack.data.ownerUserId !== expectedUserId ||
          ack.data.id !== body.id || ack.data.version !== body.version) {
          throw new DesktopCloudError(CARD_LIBRARY_REQUEST_COMMAND, 'invalid-response', '恢复响应无法验证，请刷新核对');
        }
      }
      return response;
    },
  };
}
