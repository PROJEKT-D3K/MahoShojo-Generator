import type { ArenaRoomPublishConfigRequest, ArenaRoomSessionResponse } from '@mahoshojo/contracts/arena-room';
import { areArenaRoomSharedConfigsSemanticallyEqual } from './shared-config-equality';

/** Ephemeral target only. Host identity/credential lifetime remains the caller's responsibility. */
export type ArenaRoomConfigPublishTarget = Readonly<{
  roomId: string;
  selfUserId: string;
  request: ArenaRoomPublishConfigRequest;
}>;
export type ArenaRoomConfigPublishObservation =
  | 'unobserved' | 'target-unavailable' | 'authority-unavailable'
  | 'scope-changed' | 'target-matches' | 'target-differs';

/** A snapshot describes current state, never the outcome of a particular POST. */
export const observeArenaRoomConfigPublish = (
  target: ArenaRoomConfigPublishTarget | null,
  authority: ArenaRoomSessionResponse | null,
  observed: boolean,
): ArenaRoomConfigPublishObservation => {
  if (!observed) return 'unobserved';
  if (!target) return 'target-unavailable';
  if (!authority) return 'authority-unavailable';
  if (authority.roomId !== target.roomId || authority.roomEpoch !== target.request.expectedRoomEpoch
    || authority.self.userId !== target.selfUserId || authority.self.role !== 'host'
    || authority.self.membershipState !== 'active') return 'scope-changed';
  return areArenaRoomSharedConfigsSemanticallyEqual(target.request.sharedConfig, authority.snapshot.sharedConfig)
    ? 'target-matches' : 'target-differs';
};
