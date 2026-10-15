import type { ArenaRoomSharedConfig } from '@mahoshojo/contracts/arena-room';
import { buildArenaRoomConfigDiffEntries as build, collectArenaRoomConfigDiffReferenceRequests as collect } from '@mahoshojo/ui-web/arena-room';
import { presetReferenceRequest, type ArenaRoomReferenceRequest } from '@/lib/arena-room/reference-presentation';
import { arenaLanguageCopy } from './value-copy';
export type { ArenaConfigDiffEntry } from '@mahoshojo/ui-web/arena-room';
const resolvePresetVersion = (request: ArenaRoomReferenceRequest): ArenaRoomReferenceRequest => request.source === 'preset'
  ? presetReferenceRequest(request.kind, request.id, request.versionToken) : request;
export const collectArenaRoomConfigDiffReferenceRequests = (configs: readonly (ArenaRoomSharedConfig | null)[]) => collect(configs).map(resolvePresetVersion);
export const buildArenaRoomConfigDiffEntries = (room: ArenaRoomSharedConfig, local: ArenaRoomSharedConfig | null, resolveName: (request: ArenaRoomReferenceRequest) => string | undefined) => build(room, local, request => resolveName(resolvePresetVersion(request)), arenaLanguageCopy);
