export type RoomInviteScopeSource = {
  readonly readScope: () => string | null;
  readonly subscribe: (listener: () => void) => () => void;
};

/** 每次宿主通知都观察房间退休；React 合并 A→null→A 也不能复活旧复制。 */
export function createRoomInviteScope({ readScope, subscribe }: RoomInviteScopeSource) {
  let current: string | null = null;
  let token = Symbol('room-invite-scope');
  const getSnapshot = () => {
    const scope = readScope();
    if (scope !== current) { current = scope; token = Symbol('room-invite-scope'); }
    return token;
  };
  return {
    getSnapshot,
    subscribe: (listener: () => void) => subscribe(() => { getSnapshot(); listener(); }),
  };
}
