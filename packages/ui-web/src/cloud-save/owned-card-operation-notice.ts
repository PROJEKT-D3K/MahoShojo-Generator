/** Ephemeral session warning only: never a receipt, retry ledger or stored card data. */
export type OwnedCardOperationNotice = { uncertain: boolean; owner?: object };

/** Separate operation registries share the same account/generation isolation. */
export function createOwnedCardOperationNoticeRegistry() {
  const notices = new WeakMap<object, { generation: number; owner: number; notice: OwnedCardOperationNotice }>();
  return (scope: object, generation: number, owner: number): OwnedCardOperationNotice => {
    const existing = notices.get(scope);
    if (existing?.generation === generation && existing.owner === owner) return existing.notice;
    const notice = { uncertain: false };
    notices.set(scope, { generation, owner, notice });
    return notice;
  };
}
