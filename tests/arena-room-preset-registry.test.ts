import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';
import { inferCharacterKind } from '../packages/domain/src/data-cards';
import { bindArenaRatingEntities } from '../packages/hosted-runtime/src/arena-generation/rating-entity-binding';
import { projectArenaRatingIdentity } from '../packages/hosted-runtime/src/arena-generation/rating-identity-projection';

const root = process.cwd();
const generatorPath = resolve(root, 'scripts/generate-arena-room-preset-registry.mjs');
const apiRegistryPath = resolve(root, 'apps/api/src/arena-room/generated/arena-room-preset-registry.ts');
const sharedCatalogPath = resolve(root, 'packages/multiplayer-core/src/preset-catalog.ts');
const webCatalogPath = resolve(root, 'apps/web/lib/arena-room/generated/arena-room-preset-catalog.ts');

describe('Arena Room preset registry generation contract', () => {
  it('derives every identity, canonical token and signed payload from the content authority, including legacy files', () => {
    const registry = readFileSync(apiRegistryPath, 'utf8');
    const match = registry.match(/export const GENERATED_ARENA_ROOM_PRESETS = (\[[\s\S]*\]) as const satisfies/u);
    expect(match).not.toBeNull();
    const entries = JSON.parse(match?.[1] ?? 'null') as Array<{
      id: string; kind: string; sourcePath: string; versionToken: string; payload: unknown;
    }>;
    const canonicalize = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(canonicalize);
      if (value && typeof value === 'object') return Object.fromEntries(
        Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
          .map(([key, child]) => [key, canonicalize(child)]),
      );
      return value;
    };
    const expectedIdentities: string[] = [];
    for (const [directory, kind] of [['presets', 'character'], ['scenario-presets', 'scenario']]) {
      const files = readdirSync(resolve(root, 'content', directory)).sort();
      for (const id of files) {
        const entry = entries.find((candidate) => candidate.id === id && candidate.kind === kind);
        const sourcePath = `content/${directory}/${id}`;
        expect(entry, sourcePath).toBeDefined();
        const payload = JSON.parse(readFileSync(resolve(root, sourcePath), 'utf8'));
        expect(entry?.sourcePath).toBe(sourcePath);
        expect(entry?.payload).toEqual(payload);
        expect(entry?.versionToken).toBe(`sha256:${createHash('sha256').update(JSON.stringify(canonicalize(payload))).digest('hex')}`);
        expectedIdentities.push(`${kind}:${id}`);
      }
    }
    expect(entries.map((entry) => `${entry.kind}:${entry.id}`).sort()).toEqual(expectedIdentities.sort());
    expect(entries.some((entry) => entry.id === 'M01_centaurea_legacy.json')).toBe(true);
    const authority = readFileSync(resolve(root, 'packages/hosted-runtime/src/arena-generation/generated/arena-preset-authority.ts'), 'utf8');
    const authorityMatch = authority.match(/export const ARENA_PRESET_AUTHORITY = (\[[\s\S]*\]) as const satisfies/u);
    expect(authorityMatch).not.toBeNull();
    const authorityEntries = JSON.parse(authorityMatch?.[1] ?? 'null') as Array<{
      id: string; kind: string; versionToken: string; ratingIdentityDigest: string | null;
    }>;
    // The existing canonical version token remains the full signed document token.
    // Rating identity is an additional server-only projection, never its replacement.
    expect(authorityEntries.map(({ id, kind, versionToken }) => ({ id, kind, versionToken })))
      .toEqual(entries.map(({ id, kind, versionToken }) => ({ id, kind, versionToken })));
    for (const entry of authorityEntries) {
      expect(Object.keys(entry).sort()).toEqual(['id', 'kind', 'ratingIdentityDigest', 'versionToken']);
      const source = entries.find(({ id, kind }) => id === entry.id && kind === entry.kind);
      expect(source).toBeDefined();
      const expectedDigest = entry.kind === 'character'
        ? `sha256:${createHash('sha256').update(JSON.stringify(canonicalize(projectArenaRatingIdentity(source?.payload)))).digest('hex')}`
        : null;
      expect(entry.ratingIdentityDigest, `${entry.kind}:${entry.id}`).toBe(expectedDigest);
    }
    const catalog = readFileSync(sharedCatalogPath, 'utf8');
    const catalogMatch = catalog.match(/export const ARENA_ROOM_PRESET_CATALOG = (\[[\s\S]*\]) as const satisfies/u);
    const metadata = JSON.parse(catalogMatch?.[1] ?? 'null') as Array<{ id: string; kind: string; versionToken: string }>;
    expect(metadata.map(({ id, kind, versionToken }) => ({ id, kind, versionToken })))
      .toEqual(entries.map(({ id, kind, versionToken }) => ({ id, kind, versionToken })));
  });

  it('binds each original character preset and rejects a changed body under the same preset identity', async () => {
    const sourceDirectory = resolve(root, 'content/presets');
    const presets = readdirSync(sourceDirectory).filter((name) => name.endsWith('.json')).sort().map((id) => {
      const data = JSON.parse(readFileSync(resolve(sourceDirectory, id), 'utf8')) as Record<string, unknown>;
      const kind = inferCharacterKind(data);
      return { type: kind === 'general' ? 'general-character' : kind, isPreset: true, filename: id, data };
    });
    expect(presets.length).toBeGreaterThan(1);
    const request = new Request('https://example.test/api/arena/generate');
    for (const preset of presets) {
      const opponent = presets.find(({ filename }) => filename !== preset.filename)!;
      const bind = (data: Record<string, unknown>) => bindArenaRatingEntities({
        request, payload: { combatants: [{ ...preset, data }, opponent] },
      });
      const original = structuredClone(preset.data);
      const binding = await bind(preset.data);
      expect(binding.status, preset.filename).toBe('bound');
      if (binding.status === 'bound') {
        expect(binding.entities.map(({ entityType, entityId }) => ({ entityType, entityId }))).toEqual([
          { entityType: 'preset', entityId: preset.filename },
          { entityType: 'preset', entityId: opponent.filename },
        ]);
      }
      const identityField = 'codename' in preset.data ? 'codename' : 'name';
      expect(await bind({ ...preset.data, [identityField]: 'modified character identity' }), preset.filename)
        .toEqual({ version: 1, status: 'unbound', reason: 'entity-body-mismatch' });
      expect(preset.data, 'binding must not rewrite the source document').toEqual(original);
    }
  });

  it('generates a shared client-safe metadata catalog from the same source and rejects duplicate identities', () => {
    expect(existsSync(generatorPath)).toBe(true);
    expect(existsSync(apiRegistryPath)).toBe(true);
    expect(existsSync(sharedCatalogPath), '缺少共享 safe preset metadata catalog').toBe(true);
    expect(readFileSync(webCatalogPath, 'utf8')).toContain("from '@mahoshojo/multiplayer-core/preset-catalog'");

    const generator = readFileSync(generatorPath, 'utf8');
    expect(generator).toContain('arena-room-preset-catalog.ts');
    expect(generator).toContain('new Set');
    expect(generator).toContain('duplicate');
    expect(generator).toContain('process.argv.includes(\'--check\')');

    const catalog = readFileSync(sharedCatalogPath, 'utf8');
    expect(catalog).not.toMatch(/^\s*payload\s*:/mu);
    expect(catalog).not.toContain('sourcePath');
    const match = catalog.match(/export const ARENA_ROOM_PRESET_CATALOG = (\[[\s\S]*\]) as const satisfies/u);
    expect(match, 'Shared catalog must expose a generated literal catalog').not.toBeNull();
    const entries = JSON.parse(match?.[1] ?? 'null') as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    const identities = entries.map((entry) => `${entry.kind}\u0000${entry.id}`);
    expect(new Set(identities).size).toBe(identities.length);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['displayName', 'id', 'kind', 'sourceType', 'versionToken']);
      expect(entry.versionToken).toMatch(/^sha256:[a-f0-9]{64}$/u);
    }
  });
});
