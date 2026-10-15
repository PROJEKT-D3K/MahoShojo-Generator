import { OwnedDataCardDeletionPreviewQuerySchema, OwnedDataCardDeletionRequestSchema, OwnedRecycleBinPurgeRequestSchema } from '@mahoshojo/contracts/data-cards';
import type { OwnedCardDeletePort, DeleteWrite } from '@mahoshojo/ui-web/cloud-save';
import { requestCardLibraryRoute } from './card-library-bridge';
import type { InvokeFn } from './cloud-bridge';

/** Fixed Native routes only; no legacy, HTTP or transport retry path. */
export function createDesktopOwnedCardDeletePort(invokeFn: InvokeFn, expectedUserId: number, isCurrent: () => boolean,
  options: Pick<OwnedCardDeletePort, 'isBlocked' | 'onBusyChange' | 'onChanged' | 'notice'> = {},
): OwnedCardDeletePort {
  const assertCurrent = (signal: AbortSignal) => { if (signal.aborted || !isCurrent()) throw new Error('账号会话已改变'); };
  const run = async (request: Parameters<typeof requestCardLibraryRoute>[1], signal: AbortSignal) => {
    assertCurrent(signal);
    const response = await requestCardLibraryRoute(invokeFn, request);
    assertCurrent(signal);
    return response;
  };
  return {
    ...options, expectedUserId, isCurrent,
    preview(scope, id, signal) {
      const query = OwnedDataCardDeletionPreviewQuerySchema.parse({ expectedUserId, scope, ...(id !== undefined ? { id } : {}) });
      return run({ routeId: 'data-cards.delete-preview.query', expectedUserId, query: { scope: query.scope, ...(query.id !== undefined ? { id: query.id } : {}) } }, signal);
    },
    write(input: DeleteWrite, signal) {
      if (input.operation === 'purge-recycle') {
        const body = OwnedRecycleBinPurgeRequestSchema.parse({ expectedUserId, targets: input.targets, ...(input.continuationTarget ? { continuationTarget: input.continuationTarget } : {}) });
        return run({ routeId: 'data-cards.purge-recycle', expectedUserId, body }, signal);
      }
      const body = OwnedDataCardDeletionRequestSchema.parse({ expectedUserId, ...input.target });
      return run({ routeId: input.operation === 'soft-delete' ? 'data-cards.soft-delete' : 'data-cards.purge-active', expectedUserId, body }, signal);
    },
  };
}
