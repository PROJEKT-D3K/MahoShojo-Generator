import { describe, expect, it } from 'vitest';

import {
  ARENA_ROOM_PRESET_CATALOG as sharedCatalog,
  type ArenaRoomPresetCatalogEntry as SharedEntry,
} from '@mahoshojo/multiplayer-core/preset-catalog';
import {
  ARENA_ROOM_PRESET_CATALOG as webCatalog,
  type ArenaRoomPresetCatalogEntry as WebEntry,
} from '@/lib/arena-room/generated/arena-room-preset-catalog';

const webEntries: readonly WebEntry[] = webCatalog;
const sharedEntries: readonly SharedEntry[] = webEntries;

describe('Arena Room preset catalog compatibility', () => {
  it('keeps the existing Web value and type exports on the shared catalog itself', () => {
    expect(webCatalog).toBe(sharedCatalog);
    expect(sharedEntries).toBe(sharedCatalog);
    for (const [index, entry] of webCatalog.entries()) {
      expect(entry).toBe(sharedCatalog[index]);
    }
  });
});
