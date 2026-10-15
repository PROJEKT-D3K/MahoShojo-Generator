/** Ephemeral session warning only: never a receipt, retry ledger or stored card data. */
export type OwnedCardOperationNotice = { uncertain: boolean; owner?: object };

/** Separate operation registries share the same account/generation isolation. */
export function createOwnedCardOperationSessionRegistry<T>(create: () => T) {
  const notices = new WeakMap<object, { generation: number; owner: number; notice: T }>();
  return (scope: object, generation: number, owner: number): T => {
    const existing = notices.get(scope);
    if (existing?.generation === generation && existing.owner === owner) return existing.notice;
    const notice = create();
    notices.set(scope, { generation, owner, notice });
    return notice;
  };
}

export const createOwnedCardOperationNoticeRegistry = () => createOwnedCardOperationSessionRegistry<OwnedCardOperationNotice>(() => ({ uncertain: false }));
