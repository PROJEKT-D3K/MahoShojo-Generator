import { describe, expect, it } from 'vitest';
import { projectDesktopArenaReport, readArenaReportPresentationSnapshot } from '../src/features/arena/report-presentation';
import { createInitialArenaDraft, type ArenaSessionState } from '../src/features/arena/session';
const state = (overrides: Partial<ArenaSessionState> = {}): ArenaSessionState => ({
  draft: createInitialArenaDraft(), generation: null, report: null, hosted: null, phase: 'generating',
  rawText: '', markdown: '', reasoning: '独立思考', activeGenerationMode: 'stream', ...overrides,
} as ArenaSessionState);

describe('Desktop 原任务报告展示投影', () => {
  it('reasoning-only 保持流式卡状态，结构化部分 JSON 不作为 Markdown 正文', () => {
    expect(projectDesktopArenaReport(state())).toMatchObject({ content: '', isStreaming: true, aiReasoning: { status: 'thinking', text: '独立思考' } });
    expect(projectDesktopArenaReport(state({ activeGenerationMode: 'non-stream', markdown: '{"headline":', phase: 'failed' }))).toMatchObject({ content: '', isStreaming: false, aiReasoning: { status: 'done' } });
  });
  it('恢复时读服务端模型和规范 usage，包括可见输出标记，不猜当前目标模型', () => {
    const projected = projectDesktopArenaReport(state({ hosted: {
      headerMeta: { mode: 'daily', scenarioDisplayName: '旧情景', reporterInfo: { name: '记者', publication: '日报' } },
      telemetry: { aiModel: 'server-actual', usage: { completionTokens: 7, completionTokensIncludesReasoning: false, reasoningTokens: 4 } },
    } as unknown as ArenaSessionState['hosted'] }));
    expect(projected.aiModel).toBe('server-actual'); expect(projected.scenarioName).toBeUndefined();
    expect(projected.aiUsage).toEqual({ completionTokens: 7, reasoningTokens: 4, completionTokensIncludesReasoning: false });
    expect(projectDesktopArenaReport(state()).aiModel).toBeNull(); expect(projectDesktopArenaReport(state()).aiUsage).toBeNull();
  });
  it('展示快照只认版本和白名单，不收模型正文元数据或写入能力，不截断合法长字段', () => {
    expect(readArenaReportPresentationSnapshot({ aiModel: 'old' })).toBeNull();
    const value = readArenaReportPresentationSnapshot({ version: 1, mode: 'scenario', aiModel: 'actual',
      reporterInfo: { name: '记'.repeat(400), publication: '日报' }, characterGuidances: [{ characterName: '名'.repeat(400), guidance: '勇敢' }],
      userGuidance: '引'.repeat(300), aiUsage: { textTokens: 0, completionTokensIncludesReasoning: false }, generation: {}, candidates: {}, content: '不重复',
      adjudicationResults: [{ depth: 0, type: 'future-type', description: '描述', roll: 1, outcome: '结果', details: '细节' }],
    });
    expect(value?.reporterInfo?.name).toHaveLength(400); expect(value?.characterGuidances?.[0]?.characterName).toHaveLength(400);
    expect(value?.userGuidance).toHaveLength(300); expect(value?.aiUsage).toEqual({ textTokens: 0, completionTokensIncludesReasoning: false });
    expect(value?.adjudicationResults?.[0]?.type).toBe('future-type');
    for (const field of ['generation', 'candidates', 'content']) expect(value).not.toHaveProperty(field);
  });
});
