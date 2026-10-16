import { useId } from 'react';
import {
  formatBattleStoryChapterPlanSource,
  formatBattleStoryChapterProgress,
  type BattleStoryChapterPlan,
  type BattleStoryDraftChapterPlanMode,
} from '@mahoshojo/domain/arena-battle-story-session';
import {
  SCENARIO_BATTLE_STORY_MAX_TOTAL_CHAPTERS,
  type ScenarioBattleStoryConfig,
} from '@mahoshojo/domain/scenario-battle-story';

const QUICK_OPTIONS = [2, 3, 5, 8, 12] as const;

export interface BattleStoryChapterPlanControlProps {
  mode: BattleStoryDraftChapterPlanMode;
  input: string;
  plan: BattleStoryChapterPlan | null | undefined;
  scenarioPlan?: ScenarioBattleStoryConfig | null;
  locked: boolean;
  disabled?: boolean;
  error?: string | null;
  onModeChange(mode: BattleStoryDraftChapterPlanMode): void;
  onInputChange(value: string): void;
}

/** Only edits the next story's controlled draft. Dispatch, persistence and busy policy stay with the host. */
export function BattleStoryChapterPlanControl(props: BattleStoryChapterPlanControlProps) {
  const { mode, input, plan, scenarioPlan, locked, disabled = false, error, onModeChange, onInputChange } = props;
  const id = useId();
  const blocked = disabled || locked;
  const sourceLabel = formatBattleStoryChapterPlanSource(plan);
  const progressText = formatBattleStoryChapterProgress({ completedChapterCount: 0, chapterPlan: plan });
  return <section aria-label="新会话章节规划" className="rounded-2xl border border-gray-200 bg-white p-4">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <div className="text-sm font-semibold text-gray-800">新会话章节规划</div>
        <div className="mt-1 text-xs text-gray-500">仅影响下一次“新建连续战报”，不会修改普通竞技场设置。</div>
      </div>
      {plan ? <span className="rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs font-medium text-blue-700">{sourceLabel}｜{progressText}</span>
        : <span className="rounded-full border border-gray-200 bg-gray-50 px-2.5 py-1 text-xs font-medium text-gray-600">{error ? '请检查章节数' : '不限制'}</span>}
    </div>
    <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="章节规划快捷选项">
      <button type="button" disabled={blocked} aria-pressed={mode === 'auto'}
        onClick={() => onModeChange('auto')}
        className={`rounded-full border px-3 py-1.5 text-xs font-medium ${mode === 'auto' ? 'border-blue-300 bg-blue-50 text-blue-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
        title={scenarioPlan ? `沿用情景卡${scenarioPlan.planMode === 'fixed' ? '固定' : '建议'}章节数` : '未检测到情景卡章节规划时，此模式等同于不限制'}>自动</button>
      <button type="button" disabled={blocked} aria-pressed={mode === 'none'}
        onClick={() => onModeChange('none')}
        className={`rounded-full border px-3 py-1.5 text-xs font-medium ${mode === 'none' ? 'border-gray-400 bg-gray-100 text-gray-800' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}
        title="显式关闭章节上限，按开放式会话续写">不限制</button>
      {QUICK_OPTIONS.map(option => <button key={option} type="button" disabled={blocked}
        aria-pressed={mode === 'custom' && input === String(option)}
        onClick={() => { onModeChange('custom'); onInputChange(String(option)); }}
        className={`rounded-full border px-3 py-1.5 text-xs font-medium ${mode === 'custom' && input === String(option) ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-gray-200 bg-white text-gray-600 hover:bg-gray-50'}`}>{option} 章</button>)}
    </div>
    <div className="mt-4 grid gap-3 md:grid-cols-[minmax(0,220px)_minmax(0,1fr)]">
      <div>
        <label htmlFor={`${id}-input`} className="mb-1 block text-xs font-medium text-gray-600">自定义总章节数</label>
        <input id={`${id}-input`} type="number" min={1} max={SCENARIO_BATTLE_STORY_MAX_TOTAL_CHAPTERS}
          value={locked ? String(plan?.totalChapters ?? scenarioPlan?.totalChapters ?? '') : mode === 'custom' ? input : ''}
          disabled={blocked} aria-invalid={!!error} aria-describedby={error ? `${id}-error ${id}-help` : `${id}-help`}
          onChange={event => { onModeChange('custom'); onInputChange(event.target.value); }}
          className="w-full rounded-xl border border-gray-200 px-3 py-2 text-sm text-gray-700 focus:border-blue-400 focus:outline-none focus:ring-2 focus:ring-blue-100 disabled:bg-gray-50 disabled:text-gray-500"
          placeholder={`1-${SCENARIO_BATTLE_STORY_MAX_TOTAL_CHAPTERS}`} />
        {error ? <p id={`${id}-error`} role="alert" className="mt-2 text-xs text-red-600">{error}</p> : null}
      </div>
      <div id={`${id}-help`} className="rounded-xl border border-gray-200 bg-gray-50 px-3 py-3 text-xs text-gray-600">
        {locked ? <>当前主情景固定为 {plan?.totalChapters ?? scenarioPlan?.totalChapters} 章，创建会话时会强制继承，用户不可改。</>
          : error ? <>请修正章节数后再新建连续战报；已有故事不受影响。</>
            : plan ? <>当前将以“{sourceLabel ?? '章节规划'}”启动新会话，计划章节数为 {progressText}。达到上限后将禁止继续续写和追加分支新章。</>
              : scenarioPlan?.planMode === 'suggested' ? <>当前主情景建议 {scenarioPlan.totalChapters} 章；可保持“自动”，也可切换为不限制或自定义数值。</>
                : <>未设置章节上限时，连续战报会按开放式会话运行，由你手动决定何时停止。</>}
      </div>
    </div>
  </section>;
}
