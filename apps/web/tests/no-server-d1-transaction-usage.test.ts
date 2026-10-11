import { describe, expect, test } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse } from '@typescript-eslint/typescript-estree';

type TransactionViolation = {
  filePath: string;
  line: number;
  column: number;
  snippet: string;
};

const repoRoot = process.cwd();
const sourceRoots = ['app', 'components', 'lib', 'pages', 'scripts'];
const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const allowedTransactionFiles = new Set([
  // 仅允许浏览器端 IndexedDB 存储模块使用 transaction。
  'lib/magic-tea-party/storage.ts',
  'lib/ai-session/battle-story/storage.ts',
  // 连续故事完成章的三 store 原子提交，同样只使用浏览器 IndexedDB。
  'lib/ai-session/battle-story/commit-storage.ts',
  // 故事全图快照、分支、重写与截尾原子保存，仅通过 openAiSessionDb 获取浏览器 IDBDatabase。
  'lib/ai-session/battle-story/source-storage.ts',
  'lib/ai-session/battle-story/branch-commit-storage.ts',
  'lib/ai-session/battle-story/tail-rewrite-commit-storage.ts',
  'lib/ai-session/battle-story/middle-rewrite-commit-storage.ts',
  'lib/ai-session/battle-story/truncation-commit-storage.ts',
  'lib/public-card-cache/storage.ts',
  'lib/web-package/cache.ts',
  // 浏览器端 IndexedDB 本地库存储（ADR-local-library-data-ownership §4 / LIB-002）。
  'lib/local-library/db.ts',
]);

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const normalizeRelativePath = (filePath: string): string => filePath.split(path.sep).join('/');

const shouldScanFile = (relativePath: string): boolean => {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.startsWith('tests/')) return false;
  if (normalized.includes('/__tests__/')) return false;
  if (normalized.includes('/node_modules/')) return false;
  if (normalized.includes('/.next/')) return false;
  return sourceExtensions.has(path.extname(normalized));
};

const collectSourceFiles = async (relativeDir: string): Promise<string[]> => {
  const absoluteDir = path.join(repoRoot, relativeDir);
  try {
    const entries = await readdir(absoluteDir, { withFileTypes: true });
    const files: string[] = [];

    for (const entry of entries) {
      const relativePath = path.join(relativeDir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await collectSourceFiles(relativePath)));
        continue;
      }
      if (entry.isFile() && shouldScanFile(relativePath)) {
        files.push(normalizeRelativePath(relativePath));
      }
    }

    return files;
  } catch {
    return [];
  }
};

const getMemberPropertyName = (node: Record<string, unknown>): string | null => {
  const property = node.property;
  const computed = node.computed === true;

  if (!computed && isObjectRecord(property) && property.type === 'Identifier' && typeof property.name === 'string') {
    return property.name;
  }

  if (computed && isObjectRecord(property) && property.type === 'Literal' && typeof property.value === 'string') {
    return property.value;
  }

  return null;
};

const getCalleeMemberExpression = (callee: unknown): Record<string, unknown> | null => {
  if (!isObjectRecord(callee)) return null;
  if (callee.type === 'MemberExpression') return callee;
  if (callee.type === 'ChainExpression' && isObjectRecord(callee.expression) && callee.expression.type === 'MemberExpression') {
    return callee.expression;
  }
  return null;
};

const visitNode = (node: unknown, visitor: (node: Record<string, unknown>) => void): void => {
  if (!isObjectRecord(node)) return;
  visitor(node);

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      value.forEach((item) => visitNode(item, visitor));
      continue;
    }
    visitNode(value, visitor);
  }
};

const findTransactionViolations = (filePath: string, sourceText: string): TransactionViolation[] => {
  const extension = path.extname(filePath).toLowerCase();
  const enableJsx = extension === '.tsx' || extension === '.jsx';
  const ast = parse(sourceText, {
    filePath,
    loc: true,
    range: true,
    jsx: enableJsx,
    comment: false,
    sourceType: 'module',
  });

  const violations: TransactionViolation[] = [];

  visitNode(ast, (node) => {
    if (node.type !== 'CallExpression') return;
    const memberExpression = getCalleeMemberExpression(node.callee);
    if (!memberExpression) return;

    if (getMemberPropertyName(memberExpression) !== 'transaction') return;

    const loc = isObjectRecord(node.loc) && isObjectRecord(node.loc.start) ? node.loc.start : null;
    const range = Array.isArray(node.range) ? node.range : null;
    const start = typeof range?.[0] === 'number' ? range[0] : 0;
    const end = typeof range?.[1] === 'number' ? range[1] : Math.min(sourceText.length, start + 120);
    const snippet = sourceText
      .slice(start, end)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)[0] ?? '.transaction(...)';

    violations.push({
      filePath,
      line: typeof loc?.line === 'number' ? loc.line : 1,
      column: typeof loc?.column === 'number' ? loc.column + 1 : 1,
      snippet,
    });
  });

  return violations;
};

describe('server D1 transaction guard', () => {
  test.each([
    'app/api/story/branch-commit-storage.ts',
    'lib/server/branch-commit-storage.ts',
    'lib/ai-session/battle-story/branch-commit-storage.server.ts',
    'app/api/story/tail-rewrite-commit-storage.ts',
    'lib/server/tail-rewrite-commit-storage.ts',
    'lib/ai-session/battle-story/tail-rewrite-commit-storage.server.ts',
    'app/api/story/middle-rewrite-commit-storage.ts',
    'lib/server/middle-rewrite-commit-storage.ts',
    'lib/ai-session/battle-story/middle-rewrite-commit-storage.server.ts',
    'app/api/story/truncation-commit-storage.ts',
    'lib/server/truncation-commit-storage.ts',
    'lib/ai-session/battle-story/truncation-commit-storage.server.ts',
    'app/api/story/source-storage.ts',
    'lib/server/source-storage.ts',
    'lib/ai-session/battle-story/source-storage.server.ts',
  ])('浏览器例外不放行服务端或相似路径 %s', (filePath) => {
    expect(allowedTransactionFiles.has(filePath)).toBe(false);
    expect(findTransactionViolations(filePath, 'await db.transaction(async (tx) => tx.insert(table));'))
      .toEqual([expect.objectContaining({ filePath, line: 1, snippet: 'db.transaction(async (tx) => tx.insert(table))' })]);
  });

  test.each([
    { filePath: 'lib/ai-session/battle-story/source-storage.ts', transactions: [
      "db.transaction(storeNames, 'readonly')",
    ] },
    { filePath: 'lib/ai-session/battle-story/branch-commit-storage.ts', transactions: [
      "db.transaction(stores.battleStoryChapters, 'readonly')", "db.transaction(storeNames, 'readwrite')",
    ] },
    { filePath: 'lib/ai-session/battle-story/tail-rewrite-commit-storage.ts', transactions: [
      "db.transaction(stores.battleStoryChapters, 'readonly')", "db.transaction(storeNames, 'readwrite')",
    ] },
    { filePath: 'lib/ai-session/battle-story/middle-rewrite-commit-storage.ts', transactions: [
      "db.transaction(stores.battleStoryChapters, 'readonly')", "db.transaction(storeNames, 'readwrite')",
    ] },
    { filePath: 'lib/ai-session/battle-story/truncation-commit-storage.ts', transactions: [
      "db.transaction(storeNames, 'readwrite')",
    ] },
  ])('故事例外只登记经浏览器数据库工厂取得的实际 IDB 模块 $filePath', async ({ filePath, transactions }) => {
    expect(allowedTransactionFiles.has(filePath)).toBe(true);
    const source = await readFile(path.join(repoRoot, filePath), 'utf8');
    expect(source).toContain("from '@/lib/ai-session/storage'");
    // 每个独立入口均取得浏览器数据库；迁移后 readonly 全图由 source-storage 单独承载。
    expect(source.match(/\bdb\s*=\s*await openAiSessionDb\(\)/gu)).toHaveLength(transactions.length);
    // 精确记录 receiver、模式与调用数，不能以新增文件豁免未来出现的额外事务。
    expect(findTransactionViolations(filePath, source).map((violation) => violation.snippet)).toEqual(transactions);
  });

  test('除显式白名单外，源码中不允许再出现 .transaction() 调用', async () => {
    const sourceFiles = (
      await Promise.all(sourceRoots.map((relativeDir) => collectSourceFiles(relativeDir)))
    ).flat();

    const violations: TransactionViolation[] = [];

    for (const filePath of sourceFiles) {
      if (allowedTransactionFiles.has(filePath)) continue;
      const absolutePath = path.join(repoRoot, filePath);
      const sourceText = await readFile(absolutePath, 'utf8');
      if (!sourceText.includes('.transaction')) continue;
      violations.push(...findTransactionViolations(filePath, sourceText));
    }

    const message = violations
      .map((item) => `- ${item.filePath}:${item.line}:${item.column} -> ${item.snippet}`)
      .join('\n');

    expect(
      violations,
      message ||
        '检测通过：未在服务端源码中发现新的 .transaction() 调用；如需新增显式例外，请先评估是否为浏览器 IndexedDB 场景。',
    ).toEqual([]);
  });
});
