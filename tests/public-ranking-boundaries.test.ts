import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { PUBLIC_RANKING_BODY_BUDGETS, PublicSeasonArchiveSchema, PublicSeasonsSchema } from '../packages/contracts/src/public-ranking';
const root = resolve(import.meta.dirname, '..');
describe('public ranking actual sources and browser boundaries', () => {
  it('accepts all committed archive facts and optional season metadata within the frozen response budgets', () => {
    const config = readFileSync(resolve(root, 'apps/web/public/config/seasons.json'));
    expect(config.byteLength).toBeLessThan(PUBLIC_RANKING_BODY_BUDGETS.seasons);
    expect(PublicSeasonsSchema.safeParse(JSON.parse(config.toString())).success).toBe(true);
    for (const id of ['Alpha', 'S0', 'S1', 'S2', 'S3']) {
      const bytes = readFileSync(resolve(root, `apps/web/public/data/seasons/archive_${id}.json`));
      expect(bytes.byteLength).toBeLessThan(PUBLIC_RANKING_BODY_BUDGETS.archive);
      const archive = PublicSeasonArchiveSchema.parse(JSON.parse(bytes.toString()));
      expect(archive.season.id).toBe(id);
    }
  });
  it('keeps pure tier/archive derivations free of host, server queen cache and generation rule imports', async () => {
    const bundled = await build({ entryPoints: [resolve(root, 'packages/domain/src/public-ranking.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, metafile: true });
    const inputs = Object.keys(bundled.metafile!.inputs);
    expect(inputs.some((path) => /apps\/|hosted-runtime|ui-web|node_modules\/react\//.test(path))).toBe(false);
    expect(bundled.outputFiles[0]!.text).not.toMatch(/queryArenaPublicQueenEntity|queenCache|deriveSeasonStrictRules|fetch\(/);
  });
  it('registers the actual route and both actual hosts import the same shared main view', () => {
    for (const path of ['apps/web/components/ranking/RankingPage.tsx', 'apps/desktop/src/app/ranking-page.tsx']) {
      const source = readFileSync(resolve(root, path), 'utf8');
      expect(source).toContain("from '@mahoshojo/ui-web/ranking'"); expect(source).toContain('<RankingPageView');
    }
    const routes = readFileSync(resolve(root, 'apps/desktop/src/app/routes.tsx'), 'utf8');
    expect(routes).toContain("path: '/ranking'"); expect(routes).toContain("import('./ranking-page')"); expect(routes).toContain('  rankingRoute,');
    expect(readFileSync(resolve(root, 'apps/desktop/src/app/delivered-routes.ts'), 'utf8')).toContain("'/ranking'");
    expect(readFileSync(resolve(root, 'apps/desktop/src/app/ranking-page.tsx'), 'utf8')).not.toContain('onOpenEntityDetails');
  });
});
