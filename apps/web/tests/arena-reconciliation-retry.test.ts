import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { buildArenaReconciliationRetryPayload } from '@/lib/arena/reconciliation-retry';

describe('Arena 角色更新恢复', () => {
  it('仅使用同一 generation 与保留稳定身份 wrapper 的当前卡片重试冻结 effect', async () => {
    const payload = await buildArenaReconciliationRetryPayload('generation-retry-001', [
      {
        type: 'magical-girl',
        data: { name: '小锦', signature: 'signed' },
        isValid: true,
        isPreset: true,
        filename: 'C01_egg.json',
        sourceDataCardId: 'card-1',
        roomCombatantKey: 'data-card:card-1',
        characterGuidance: '保持冷静',
      },
    ]);

    expect(payload).toEqual({
      generationId: 'generation-retry-001',
      combatants: [
        {
          type: 'magical-girl',
          data: { name: '小锦', signature: 'signed' },
          isPreset: true,
          filename: 'C01_egg.json',
          sourceDataCardId: 'card-1',
          roomCombatantKey: 'data-card:card-1',
        },
      ],
    });
    expect(payload).not.toHaveProperty('report');
    expect(payload).not.toHaveProperty('impacts');
    expect(payload).not.toHaveProperty('writeArenaHistory');
  });

  // 保留尚未由真实 hook 行为测试覆盖的权威重试接线护栏。
  it('权威重试走 updater 重试原语与房间权威快照，且不进入 repair 的 cooldown 副作用', () => {
    const engineSource = readFileSync('components/arena/hooks/useBattleEngine.ts', 'utf8');
    const resultSource = readFileSync('components/arena/components/BattleResult.tsx', 'utf8');
    const repairSource = readFileSync('components/arena/hooks/useCombatantRepair.ts', 'utf8');

    // 权威重试委派给 updater 的重试原语，而不是自己拼请求
    expect(engineSource).toContain('retryGenerationUpdate(');
    // 依据房间权威快照，而不是本地乐观状态
    expect(engineSource).toContain('arenaRoomRuntime?.controller.getSnapshot().session');
    // 写入必须经过 mutation permit（这是并发护栏，少了它就是一条真实回归）
    expect(engineSource).toContain('state.tryBeginCombatantMutation()');
    // 幂等守卫：本次 generation 已经应用过修复就不再重试
    expect(engineSource).toContain('currentState.repairAppliedGenerationId === lastGenerationId');

    // 已退役的两条路径不得复活
    expect(engineSource).not.toContain("fetch('/api/arena/redo-combatant-updates'");
    expect(engineSource).not.toContain('handleApplyManualMetaUpdates');
    expect(resultSource).not.toContain('precheckBattleReportForRedo');
    expect(repairSource).not.toContain('/api/arena/redo-combatant-updates');

    // 只检查重试函数；正常生成仍需 cooldown。
    const retryStart = engineSource.indexOf('const handleRetryUpdates');
    expect(retryStart).toBeGreaterThan(-1);
    const retryEnd = engineSource.indexOf('\n  return {', retryStart);
    expect(retryEnd).toBeGreaterThan(retryStart);
    const retrySource = engineSource.slice(retryStart, retryEnd);
    expect(retrySource).not.toContain('Cooldown');
  });

  it('角色对账 transport 与 domain exports 不再包含完整卡片 baseRevisionHash', () => {
    const sources = [
      'app/api/arena/update-combatants-after-stream/handler.ts',
      'components/arena/hooks/useStreamCombatantUpdater.ts',
      'components/arena/hooks/useBattleStorySession.ts',
      'lib/arena/reconciliation-retry.ts',
      '../../packages/domain/package.json',
      '../../packages/domain/src/index.ts',
      '../../packages/hosted-runtime/src/arena-generation/d1-finalization.ts',
    ].map((path) => readFileSync(path, 'utf8'));

    expect(sources.join('\n')).not.toContain('baseRevisionHash');
  });
});
