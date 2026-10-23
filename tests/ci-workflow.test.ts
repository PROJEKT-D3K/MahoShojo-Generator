import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { hasBash } from './support/posix';

const read = (file: string) => readFileSync(path.resolve(file), 'utf8');
const workflow = parse(read('.github/workflows/ci.yml'));
const manifest = JSON.parse(read('package.json'));
const steps = workflow.jobs.static.steps;
const runs = steps.map((step: { run?: string }) => step.run).filter(Boolean);

describe('repository CI workflow', () => {
  it('保留所有入口、完整本地验证和发布 skip_build 语义', () => {
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on.push.branches).toEqual(['refactor/platform-rearchitecture']);
    expect(workflow.on).toHaveProperty('workflow_dispatch');
    expect(workflow.on.workflow_call.inputs.skip_build.default).toBe(false);
    expect(manifest.scripts['ci:verify']).toBe('pnpm run workspace:verify && pnpm run test:repo && pnpm run lint:repo');
    expect(manifest.scripts['ci:verify:checks']).toBe('pnpm run workspace:checks && pnpm run test:repo && pnpm run lint:repo');
    expect(manifest.scripts['workspace:checks']).toBe('pnpm run workspace:invariants && pnpm run workspace:test && pnpm run workspace:lint');
    expect(manifest.scripts['workspace:verify']).toBe('pnpm run workspace:checks && pnpm run workspace:build');
    const build = steps.find((step: { run?: string }) => step.run === 'pnpm run workspace:build');
    expect(build.if).toBe('${{ !inputs.skip_build }}');
    expect(steps.filter((step: { if?: string }) => step.if)).toEqual([build]);
    expect(runs).toEqual([
      'pnpm install --frozen-lockfile', 'pnpm run workspace:lint', 'pnpm run workspace:build',
      'pnpm run workspace:invariants', 'pnpm run test:repo', 'pnpm run lint:repo',
    ]);
    expect(manifest.scripts['workspace:invariants'].split(' && ')).toEqual([
      'pnpm run check:desktop-version', 'pnpm run check:desktop-provider-catalog',
      'pnpm run check:desktop-web-execution-policies', 'pnpm run check:workspace:boundaries',
      'pnpm run check:admin-boundary', 'pnpm run check:arena-room-origins',
      'pnpm run check:arena-room-presets', 'pnpm run check:web-package-presets',
      'pnpm run check:encyclopedia-content',
    ]);
  });

  it('三个独立测试桶恰好覆盖所有 workspace，不在同一 runner 叠加 Vitest', () => {
    expect(workflow.jobs.tests.strategy['fail-fast']).toBe(false);
    expect(workflow.jobs.tests.steps.map((step: { run?: string }) => step.run).filter(Boolean)).toEqual([
      'pnpm install --frozen-lockfile', '${{ matrix.command }}',
    ]);
    const buckets = workflow.jobs.tests.strategy.matrix.include;
    expect(buckets).toEqual([
      { suite: 'desktop', command: 'pnpm --filter @mahoshojo/desktop run test' },
      { suite: 'web', command: 'pnpm --filter @mahoshojo/web run test' },
      { suite: 'other-workspaces', command: 'pnpm run ci:test:other' },
    ]);
    expect(manifest.scripts['ci:test:other']).toBe('pnpm --workspace-concurrency=1 --filter "./packages/*" --filter "./apps/*" --filter "!@mahoshojo/desktop" --filter "!@mahoshojo/web" --if-present run test');
    const names = ['apps', 'packages'].flatMap((directory) => readdirSync(directory, { withFileTypes: true })
      .filter((unit) => unit.isDirectory() && existsSync(path.join(directory, unit.name, 'package.json')))
      .map((unit) => JSON.parse(read(`${directory}/${unit.name}/package.json`)).name));
    expect(names).toContain('@mahoshojo/desktop');
    expect(names).toContain('@mahoshojo/web');
    const otherNames = names.filter((name) => !['@mahoshojo/desktop', '@mahoshojo/web'].includes(name));
    expect(new Set([...otherNames, '@mahoshojo/desktop', '@mahoshojo/web']).size).toBe(names.length);
    expect(workflow.jobs.tests.needs).toBeUndefined();
    expect(workflow.jobs.static.needs).toBeUndefined();
  });

  it('保持 required check 名称且所有失败、取消、跳过结果都不能绿', () => {
    const verify = workflow.jobs.verify;
    expect(verify.name).toBe('Verify repository');
    expect(verify.needs).toEqual(['tests', 'static']);
    expect(verify.if).toBe('${{ always() }}');
    expect(verify.steps).toHaveLength(1);
    const gate = verify.steps[0];
    expect(gate.env).toEqual({ TESTS_RESULT: '${{ needs.tests.result }}', STATIC_RESULT: '${{ needs.static.result }}' });
    expect(gate['continue-on-error']).toBeUndefined();
    expect(verify['continue-on-error']).toBeUndefined();
    // Windows 无 Bash 时仍验证结构；Linux CI 必须执行以下退出码真值表。
    if (!hasBash) return;
    for (const tests of ['success', 'failure', 'cancelled', 'skipped', '']) {
      for (const staticResult of ['success', 'failure', 'cancelled', 'skipped', '']) {
        const result = spawnSync('bash', ['-e', '-c', gate.run], {
          env: { ...process.env, TESTS_RESULT: tests, STATIC_RESULT: staticResult },
        });
        expect(result.status === 0, `${tests}/${staticResult}`).toBe(tests === 'success' && staticResult === 'success');
      }
    }
  });

  it('复用现有 pnpm store 缓存且旧验证按整轮取消，不变更部署保护', () => {
    expect(workflow.concurrency).toEqual({
      group: 'repository-ci-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true,
    });
    for (const job of [workflow.jobs.tests, workflow.jobs.static]) {
      expect(job.concurrency).toBeUndefined();
      expect(job['continue-on-error']).toBeUndefined();
      for (const step of job.steps) expect(step['continue-on-error']).toBeUndefined();
      expect(job.steps.find((step: { uses?: string }) => step.uses === 'actions/setup-node@v6').with.cache).toBe('pnpm');
      expect(job.steps.find((step: { run?: string }) => step.run === 'pnpm install --frozen-lockfile')).toBeTruthy();
    }
    const desktop = parse(read('.github/workflows/desktop-ci.yml'));
    expect(desktop.concurrency).toEqual({ group: 'desktop-ci-${{ github.workflow }}-${{ github.ref }}', 'cancel-in-progress': true });
    expect(desktop.jobs['verify-rust'].strategy.matrix.os).toEqual(['ubuntu-latest', 'windows-latest']);
    const text = read('.github/workflows/ci.yml');
    for (const forbidden of ['services:', 'verify:hosted-dr:redis', 'wrangler deploy', 'scp ', 'ssh ']) {
      expect(text).not.toContain(forbidden);
    }
  });
});
