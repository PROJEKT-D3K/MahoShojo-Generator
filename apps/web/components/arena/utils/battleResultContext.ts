import type { ArenaBattleResultContext, BattleMode, BattleStoreState } from '../types';

const battleModeFrom = (value: unknown): BattleMode | null => (
  value === 'classic' || value === 'kizuna' || value === 'daily' || value === 'scenario'
    ? value : null
);
const displayNameFrom = (value: unknown): string | null => (
  typeof value === 'string' && value.trim() ? value.trim() : null
);

/** 合法的服务器显示字段优先；旧响应缺字段时保留原请求上下文。 */
export const applyBattleResultMetadata = (
  context: ArenaBattleResultContext,
  metadata: unknown,
  sanitizeText: (text: string) => string,
): ArenaBattleResultContext => {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return context;
  const record = metadata as Record<string, unknown>;
  const battleMode = battleModeFrom(record.mode) ?? context.battleMode;
  const scenarioName = displayNameFrom(record.scenarioDisplayName);
  return Object.freeze({
    ...context,
    battleMode,
    scenarioDisplayName: battleMode === 'scenario'
      ? scenarioName ? sanitizeText(scenarioName) : context.scenarioDisplayName
      : null,
  });
};

/** 无快照的内存旧结果只按自身形状回退；不得把下一场草稿当作结果 metadata。 */
export const resolveBattleResultContext = (state: Pick<
  BattleStoreState, 'resultContext' | 'newsReport' | 'streamingMarkdown'
>): ArenaBattleResultContext | null => {
  if (state.resultContext) return state.resultContext;
  if (state.newsReport && state.streamingMarkdown === null) {
    const scenarioDisplayName = displayNameFrom(state.newsReport.scenario);
    const battleMode = battleModeFrom(state.newsReport.mode) ?? (scenarioDisplayName ? 'scenario' : null);
    return {
      generationMode: 'non-stream', battleMode,
      scenarioDisplayName: battleMode === 'scenario' ? scenarioDisplayName : null,
    };
  }
  if (!state.newsReport && state.streamingMarkdown !== null) {
    return { generationMode: 'stream', battleMode: null, scenarioDisplayName: null };
  }
  return null;
};
