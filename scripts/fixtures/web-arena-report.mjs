// Shared synthetic data for the local browser harness and its allowlisted server.
export const BODY = '完成正文标记 A；这一份生成结果不能因选择下一场设置而丢失。'.repeat(8);
export const MODEL = 'authoritative-model-A';
export const USAGE = Object.freeze({
  promptTokens: 123, completionTokens: 45, reasoningTokens: 6,
  textTokens: 39, totalTokens: 168,
});
export const GUIDANCE_A = '生成时指导 A';
export const GENERATION_ID = 'generation-harness-A';
export const scenario = (title) => ({
  content: { title, description: `${title}内容` },
  fileName: `${title}.json`, isNative: false,
});
export const SCENARIO_A = scenario('生成时情景 A');
export const REPAIR_PATCH = Object.freeze({
  impacts: [{ combatantIndex: 0, characterName: '角色甲', impact: '用户修复影响', currentStateSummary: '用户修复状态' }],
});

export const reportText = (format = 'markdown') => format === 'web'
  ? `<!doctype html><html><head><title>完成标题 A</title></head><body><h1>完成标题 A</h1><p>${BODY}</p><p>胜利者：角色甲</p></body></html>`
  : `# 完成标题 A\n\n${BODY}\n\n## 胜利者\n\n- 角色甲`;

export const makeReport = ({ format = 'markdown', metadata = 'present' } = {}) => ({
  headline: '完成标题 A',
  article: { body: BODY, analysis: '完成点评 A' },
  officialReport: { winner: '角色甲', conclusion: '完成结论 A' },
  reporterInfo: { name: '记者 A', publication: '报刊 A' },
  userGuidance: GUIDANCE_A,
  ...(metadata === 'missing' ? {} : { aiModel: MODEL, aiUsage: USAGE }),
  ...(format === 'web' ? { reportFormat: 'web', webHtml: reportText('web') } : {}),
});

export const sse = (event, payload) => `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;

/** Only these external ports are replaced. Result rendering, repair and capture stay real. */
export const MOCK_MODULE_PATHS = Object.freeze([
  'lib/client-route-adapter.tsx',
  'lib/cooldown.ts',
  'lib/sensitive-word-filter.ts',
  'lib/shield-word-filter.ts',
  'lib/arrested-backup.ts',
  'lib/auth.ts',
  'lib/useAuth.ts',
  'lib/arena/narrative-draft-owner.ts',
  'lib/use-generation-api-intent-latch.ts',
  'components/arena/hooks/useBattleActions.ts',
  'components/arena/hooks/useStreamCombatantUpdater.ts',
  'components/arena/multiplayer/useArenaRoom.ts',
  'components/arena/components/BattleIllustrationPanel.tsx',
  'components/SaveToCloudButton.tsx',
]);

/** Accept a search string explicitly so Node never needs a simulated browser global. */
export const getHarnessConfiguration = (search = '') => {
  const query = new URLSearchParams(search);
  return {
    author: query.get('author') === 'synthetic' ? 'synthetic' : 'anonymous',
    generation: query.get('generation') === 'non-stream' ? 'non-stream' : 'stream',
    format: (query.get('harnessFormat') ?? query.get('format')) === 'web' ? 'web' : 'markdown',
    metadata: query.get('metadata') === 'missing' ? 'missing' : 'present',
    fixture: query.get('fixture') === 'partial-failure' ? 'partial-failure' : 'complete',
  };
};
