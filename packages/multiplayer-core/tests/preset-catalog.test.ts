import { resolve } from 'node:path';

import { DataCardRefSchema } from '@mahoshojo/contracts/arena-room';
import {
  ARENA_ROOM_PRESET_CATALOG,
  type ArenaRoomPresetCatalogEntry,
} from '@mahoshojo/multiplayer-core/preset-catalog';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';

const catalog: readonly ArenaRoomPresetCatalogEntry[] = ARENA_ROOM_PRESET_CATALOG;

describe('shared Arena Room preset catalog', () => {
  it('exposes only the five safe metadata fields with unique, valid exact preset refs', () => {
    expect(catalog.length).toBeGreaterThan(0);
    expect(new Set(catalog.map(({ kind }) => kind))).toEqual(new Set(['character', 'scenario']));
    const identities = catalog.map(({ id, kind }) => `${kind}\u0000${id}`);
    expect(new Set(identities).size).toBe(catalog.length);

    for (const entry of catalog) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'kind', 'sourceType', 'versionToken']);
      const { id, kind, versionToken } = entry;
      const ref = { id, kind, versionToken };
      expect(DataCardRefSchema.parse(ref)).toEqual(ref);
      expect(versionToken).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(entry.displayName.trim()).not.toBe('');
      expect(entry.sourceType.trim()).not.toBe('');
    }
  });

  it('bundles the public subpath for browsers without loading server payloads or any runtime', async () => {
    const packageRoot = resolve(import.meta.dirname, '..');
    const bundled = await build({
      stdin: {
        contents: "export * from '@mahoshojo/multiplayer-core/preset-catalog';",
        resolveDir: packageRoot,
        sourcefile: 'preset-catalog-consumer.ts',
      },
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      metafile: true,
    });
    const sources = Object.keys(bundled.metafile!.inputs).filter((file) => file !== 'preset-catalog-consumer.ts');
    expect(sources).toHaveLength(1);
    expect(resolve(sources[0]!)).toBe(resolve(packageRoot, 'src/preset-catalog.ts'));
    expect(Object.values(bundled.metafile!.outputs).flatMap(({ imports }) => imports)).toEqual([]);
    expect(bundled.outputFiles[0]!.text).not.toMatch(/payload|sourcePath|ratingIdentityDigest|GENERATED_ARENA_ROOM_PRESETS/u);
  });
});
