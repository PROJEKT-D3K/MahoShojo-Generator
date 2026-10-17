import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { DataCardSummaryQuerySchema } from '@mahoshojo/contracts/data-cards';
import { listDataCardSummaries } from '@/lib/db/repositories/data-card-summaries';
import { dataCards } from '@/lib/db/schema';
import {
  createPublicCardQueryFixture, publicSummaryIndexMigration, publicSummaryIndexNames, queryPlan,
} from './helpers/public-data-card-query-fixture';

let fixture: ReturnType<typeof createPublicCardQueryFixture>;
beforeEach(() => { fixture = createPublicCardQueryFixture(); });
afterEach(() => fixture.sqlite.close());
const summary = (input: Record<string, unknown>) => listDataCardSummaries(
  fixture.db, null, 'public', DataCardSummaryQuerySchema.parse({ limit: 24, ...input }),
);
const sorts = (plan: ReturnType<typeof queryPlan>) => plan.filter((row) => row.detail.includes('TEMP B-TREE') && row.detail.includes('ORDER BY'));

test.each([false, true])('公开摘要默认与赞数排序使用迁移索引（ANALYZE=%s）', async (analyzed) => {
  for (const sortBy of ['created_at', 'likes']) {
    for (const types of [undefined, ['character'], ['scenario'], ['history'], ['questionnaire']]) {
      fixture.sqlite.exec(publicSummaryIndexNames.map((name) => `DROP INDEX IF EXISTS ${name}`).join(';'));
      if (analyzed) fixture.sqlite.exec('ANALYZE');
      fixture.queries.length = 0;
      const expected = await summary({ sortBy, types });
      const pageQuery = fixture.queries.find((query) => query.sql.includes('public_summary_page'))!;
      const beforePlan = queryPlan(fixture.sqlite, pageQuery);
      const pageNode = beforePlan.find((row) => row.detail.includes('CO-ROUTINE public_summary_page'))!;
      expect(sorts(beforePlan).some((row) => row.parent === pageNode.id)).toBe(true);
      fixture.sqlite.exec(publicSummaryIndexMigration);
      if (analyzed) fixture.sqlite.exec('ANALYZE');
      const plan = queryPlan(fixture.sqlite, pageQuery);
      const name = publicSummaryIndexNames[(types ? 2 : 0) + (sortBy === 'created_at' ? 0 : 1)];
      expect(plan.some((row) => row.detail.includes(name))).toBe(true);
      const indexedPageNode = plan.find((row) => row.detail.includes('CO-ROUTINE public_summary_page'))!;
      expect(sorts(plan).some((row) => row.parent === indexedPageNode.id)).toBe(false);
      // An outer sort is bounded by LIMIT; newer SQLite versions can elide it entirely.
      expect(sorts(plan).length).toBeLessThanOrEqual(1);
      expect(await summary({ sortBy, types })).toEqual(expected);
    }
  }
});

test('迁移幂等，fresh schema 与共享 Drizzle 声明保持同名；回退可安全移除新索引', () => {
  fixture.sqlite.exec(publicSummaryIndexMigration);
  fixture.sqlite.exec(publicSummaryIndexMigration);
  const definitions = () => fixture.sqlite.prepare("SELECT name, sql FROM sqlite_schema WHERE type='index' AND name LIKE 'idx_data_cards_public_summary_%' ORDER BY name").all();
  const expected = definitions();
  expect(expected).toHaveLength(4);
  expect(getTableConfig(dataCards).indexes.map((index) => index.config.name)).toEqual(publicSummaryIndexNames);
  fixture.sqlite.exec(publicSummaryIndexNames.map((name) => `DROP INDEX ${name}`).join(';'));
  expect(definitions()).toEqual([]);
  for (const [statement] of fixture.source.matchAll(/CREATE INDEX[\s\S]*?;/g)) {
    if (publicSummaryIndexNames.some((name) => statement.includes(name))) fixture.sqlite.exec(statement);
  }
  expect(definitions()).toEqual(expected);
});

test.each([false, true])('索引前后保持复杂筛选、NULL、JSON、并列翻页和审核可见性（ANALYZE=%s）', async (analyzed) => {
  const cases = [
    { sortBy: 'likes', minLikes: 0, maxLikes: 0 },
    { sortBy: 'likes', tagIds: ['tag-a', 'tag-b'], tagMatch: 'all' },
    { sortBy: 'created_at', tagIds: ['tag-a', 'tag-b'], tagMatch: 'any', offset: 24 },
    { sortBy: 'created_at', types: ['character', 'scenario'], search: 'synthetic 1', author: 'author-2' },
    { sortBy: 'likes', nativeOnly: true, recommendedOnly: true },
    { sortBy: 'created_at', nativeAllowedOnly: true, roleType: 'general' },
    { sortBy: 'created_at', types: ['questionnaire'], includeLegacyQuestionnaires: true },
    { sortBy: 'likes', types: ['questionnaire'], includeLegacyQuestionnaires: true },
    { sortBy: 'created_at', types: ['character', 'scenario'] },
    { sortBy: 'likes', types: ['scenario', 'history'] },
  ];
  if (analyzed) fixture.sqlite.exec('ANALYZE');
  const expected = await Promise.all(cases.map(summary));
  fixture.sqlite.exec(publicSummaryIndexMigration);
  if (analyzed) fixture.sqlite.exec('ANALYZE');
  expect(await Promise.all(cases.map(summary))).toEqual(expected);
  for (const sortBy of ['created_at', 'likes']) {
    const first = await summary({ sortBy });
    const next = await summary({ sortBy, offset: 24 });
    expect(new Set([...first.cards, ...next.cards].map((row) => row.id)).size).toBe(48);
    expect(first.total).toBe(2048);
    const id = first.cards[0].id;
    for (const update of ["is_public=0", "is_public=-1", "review_status='rejected'", "review_status='pending'", "review_status=NULL", "deleted_at='2026-01-01'", 'user_id=99999']) {
      fixture.sqlite.exec('SAVEPOINT visibility_check');
      fixture.sqlite.prepare(`UPDATE data_cards SET ${update} WHERE id=?`).run(id);
      const result = await summary({ sortBy });
      expect(result.total).toBe(2047);
      expect(result.cards.some((row) => row.id === id)).toBe(false);
      fixture.sqlite.exec('ROLLBACK TO visibility_check; RELEASE visibility_check');
    }
  }
});

// Opt-in synthetic evidence only. No D1 access or timing threshold in CI.
test.runIf(Boolean(process.env.PUBLIC_CARD_QUERY_BENCHMARK_DIR))('导出真实查询的合成基准输入', async () => {
  fixture.sqlite.close();
  fixture = createPublicCardQueryFixture(22481);
  const directory = process.env.PUBLIC_CARD_QUERY_BENCHMARK_DIR!;
  mkdirSync(directory, { recursive: true });
  const workloads = [];
  for (const input of [
    { sortBy: 'created_at' }, { sortBy: 'likes' },
    { sortBy: 'created_at', types: ['character'] }, { sortBy: 'likes', types: ['character'] },
    { sortBy: 'created_at', types: ['questionnaire'] }, { sortBy: 'likes', types: ['questionnaire'] },
    { sortBy: 'created_at', types: ['scenario'] }, { sortBy: 'likes', types: ['scenario'] },
    { sortBy: 'created_at', types: ['history'] }, { sortBy: 'likes', types: ['history'] },
    { sortBy: 'created_at', types: ['character', 'scenario'] }, { sortBy: 'likes', types: ['character', 'scenario'] },
    { sortBy: 'created_at', types: ['scenario', 'history'] }, { sortBy: 'likes', types: ['scenario', 'history'] },
    { sortBy: 'created_at', types: ['questionnaire'], includeLegacyQuestionnaires: true },
    { sortBy: 'likes', types: ['questionnaire'], includeLegacyQuestionnaires: true },
    { sortBy: 'likes', offset: 12000 },
    { sortBy: 'likes', tagIds: ['tag-a', 'tag-b'], tagMatch: 'all' },
    { sortBy: 'created_at', search: 'synthetic 222' }, { sortBy: 'updated_at' },
  ]) {
    fixture.queries.length = 0;
    const result = await summary(input);
    workloads.push({ input, total: result.total, ids: result.cards.map((row) => row.id), queries: [...fixture.queries] });
  }
  writeFileSync(join(directory, 'workloads.json'), JSON.stringify(workloads, null, 2));
  writeFileSync(join(directory, 'migration.sql'), publicSummaryIndexMigration);
  await fixture.sqlite.backup(join(directory, 'synthetic.sqlite'));
});
