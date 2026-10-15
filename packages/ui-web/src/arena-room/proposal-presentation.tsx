import type { ArenaProposalChange } from '@mahoshojo/contracts/arena-room';

import { arenaBattleModeCopy, arenaStoryLengthValueCopy } from './config-value-copy';

const safeText = (value: string, max = 80): string => (
  value.length <= max ? value : `${value.slice(0, max)}…`
);

const refIdentity = (value: unknown): string => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '空目标';
  const record = value as Record<string, unknown>;
  if (typeof record.id === 'string') return safeText(record.id);
  if (typeof record.key === 'string') return safeText(record.key);
  return '已绑定目标';
};

const namespacedRefIdentity = (ref: { readonly id: string }, key?: string): string => (
  `${key?.startsWith('preset:') ? '预设' : '在线'}:${safeText(ref.id)}`
);

/**
 * 提案摘要的可读名称解析插槽：返回 undefined 时回退到原始 key/ID 展示。
 * 名称和语言文案由宿主注入，共享展示不读取目录或发起请求。
 */
export type ArenaProposalChangeLabels = {
  readonly language?: (code: string) => string | undefined;
  readonly combatantKey?: (key: string) => string | undefined;
  readonly scenarioKey?: (key: string) => string | undefined;
  readonly materialKey?: (key: string) => string | undefined;
  readonly teamKey?: (key: string) => string | undefined;
  readonly ref?: (
    ref: { readonly id: string; readonly kind: string; readonly versionToken?: string },
    key?: string,
  ) => string | undefined;
};

export const arenaProposalExpectedBaseSummary = (change: ArenaProposalChange): string => {
  const expected = change.expectedBase;
  if (expected.kind === 'absent') return '提案基准：目标不存在';
  if (expected.kind === 'ref' || expected.kind === 'present') {
    return `提案基准：${typeof expected.key === 'string' ? safeText(expected.key) : refIdentity(expected.ref)}`;
  }
  return typeof expected.value === 'string'
    ? `提案基准：${safeText(expected.value || '空值')}`
    : '提案基准：已绑定安全值';
};

export const arenaProposalValueSummary = (value: unknown): string => {
  if (value === undefined) return '无';
  if (typeof value === 'string') return safeText(value || '空值', 120);
  try {
    return safeText(JSON.stringify(value), 160);
  } catch {
    return '不可序列化值';
  }
};

const combatantLabelOf = (labels: ArenaProposalChangeLabels | undefined, key: string): string => (
  labels?.combatantKey ? labels.combatantKey(key) ?? key : key
);
const teamKeyLabelOf = (labels: ArenaProposalChangeLabels | undefined, key: string): string => (
  labels?.teamKey ? labels.teamKey(key) ?? key : key
);
const scenarioKeyLabelOf = (labels: ArenaProposalChangeLabels | undefined, key: string): string => (
  labels?.scenarioKey ? labels.scenarioKey(key) ?? key : key
);
const materialKeyLabelOf = (labels: ArenaProposalChangeLabels | undefined, key: string): string => (
  labels?.materialKey ? labels.materialKey(key) ?? key : key
);

export const arenaProposalChangeSummary = (
  change: ArenaProposalChange,
  labels?: ArenaProposalChangeLabels,
): string => {
  const refLabel = (ref: { readonly id: string; readonly kind: string }, key?: string): string => (
    labels?.ref ? labels.ref(ref, key) ?? namespacedRefIdentity(ref, key) : namespacedRefIdentity(ref, key)
  );
  switch (change.type) {
    case 'addCombatant': return `新增角色 ${refLabel(change.ref, change.key)}`;
    case 'removeCombatant': return `移除角色 ${combatantLabelOf(labels, change.combatantKey)}`;
    case 'setCharacterGuidance': return `修改角色引导 ${combatantLabelOf(labels, change.combatantKey)}`;
    case 'assignTeam': return `调整队伍 ${combatantLabelOf(labels, change.combatantKey)}`;
    case 'addTeam': return `新增队伍 ${change.displayName}`;
    case 'removeTeam': return `移除队伍 ${teamKeyLabelOf(labels, change.teamKey)}`;
    case 'renameTeam': return `队伍 ${teamKeyLabelOf(labels, change.teamKey)} 改名为 ${safeText(change.value)}`;
    case 'reorderCombatants': return '调整角色顺序';
    case 'reorderTeams': return '调整队伍顺序';
    case 'reorderTeamCombatants': return `调整队伍 ${teamKeyLabelOf(labels, change.teamKey)} 内角色顺序`;
    case 'setReportFormat': return `战报格式改为 ${change.value === 'web' ? 'Web（实验性）' : 'Markdown'}`;
    case 'setWebPackageRef': return change.value ? `Web 包改为 ${change.value.id}@${change.value.version}` : '使用自由生成的 Web 战报';
    case 'setBattleMode': return `战斗模式改为 ${arenaBattleModeCopy[change.value]}`;
    case 'setSelectedLanguage': return `语言改为 ${labels?.language?.(change.value) ?? change.value}`;
    case 'setScenario': return change.ref === null ? '清除主情景' : `主情景改为 ${refLabel(change.ref, change.key)}`;
    case 'addAuxScenario': return `新增辅助情景 ${refLabel(change.ref, change.key)}`;
    case 'removeAuxScenario': return `移除辅助情景 ${scenarioKeyLabelOf(labels, change.scenarioKey)}`;
    case 'reorderAuxScenarios': return '调整辅助情景顺序';
    case 'addMaterial': return `新增素材 ${refLabel(change.ref, change.key)}`;
    case 'removeMaterial': return `移除素材 ${materialKeyLabelOf(labels, change.materialKey)}`;
    case 'reorderMaterials': return '调整素材顺序';
    case 'setUserGuidance': return `全局引导改为“${safeText(change.value || '空值')}”`;
    case 'setStoryLength': return `故事长度改为 ${arenaStoryLengthValueCopy(change.value, change.customStoryLength ?? null)}`;
    case 'setHistorySettings': return '修改共享历史读取/写入设置';
  }
};

const enabledSummary = (enabled: boolean): string => enabled ? '开' : '关';

const historyReadSummary = (
  enabled: boolean,
  unlimited: boolean,
  limit: number,
): string => {
  if (!enabled) return '关';
  return unlimited ? '开(无限)' : `开(${limit})`;
};

export const arenaProposalChangeProposedSummary = (
  change: ArenaProposalChange,
  labels?: ArenaProposalChangeLabels,
): string => {
  switch (change.type) {
    case 'reorderCombatants':
    case 'reorderTeamCombatants':
      return `${arenaProposalChangeSummary(change, labels)}：${change.value.map((key) => combatantLabelOf(labels, key)).join(' → ')}`;
    case 'reorderTeams':
      return `${arenaProposalChangeSummary(change, labels)}：${change.value.map((key) => teamKeyLabelOf(labels, key)).join(' → ')}`;
    case 'reorderAuxScenarios':
      return `${arenaProposalChangeSummary(change, labels)}：${change.value.map((key) => scenarioKeyLabelOf(labels, key)).join(' → ')}`;
    case 'reorderMaterials':
      return `${arenaProposalChangeSummary(change, labels)}：${change.value.map((key) => materialKeyLabelOf(labels, key)).join(' → ')}`;
    case 'setCharacterGuidance':
      return change.value === null
        ? `清空角色 ${combatantLabelOf(labels, change.combatantKey)} 引导`
        : `角色 ${combatantLabelOf(labels, change.combatantKey)} 引导改为“${safeText(change.value, 120)}”`;
    case 'assignTeam':
      return change.teamKey === null
        ? `角色 ${combatantLabelOf(labels, change.combatantKey)} 取消队伍分配`
        : `角色 ${combatantLabelOf(labels, change.combatantKey)} 分配至队伍 ${teamKeyLabelOf(labels, change.teamKey)}`;
    case 'setHistorySettings': {
      const value = change.value;
      return [
        `竞技场历史 读取=${historyReadSummary(value.readArenaHistory, value.isArenaHistoryUnlimited, value.readArenaHistoryLimit)}、写入=${enabledSummary(value.writeArenaHistory)}`,
        `当前状态 读取=${enabledSummary(value.readCurrentState)}、写入=${enabledSummary(value.writeCurrentState)}`,
        `叙事历史 读取=${historyReadSummary(value.readNarrativeHistory, value.isNarrativeHistoryUnlimited, value.readNarrativeHistoryLimit)}、写入=${enabledSummary(value.writeNarrativeHistory)}`,
      ].join('；');
    }
    default:
      return arenaProposalChangeSummary(change, labels);
  }
};

/**
 * 悬停提示：可读名称可能被名称缓存/策展目录遮蔽原始引用身份，
 * 这里统一暴露完整原始 key（含 namespace 与完整 ID）。
 */
export const changeRefTitle = (change: ArenaProposalChange): string | undefined => {
  switch (change.type) {
    case 'addCombatant':
    case 'addAuxScenario':
    case 'addMaterial':
      return change.key ?? `data-card:${change.ref.id}`;
    case 'setScenario':
      return change.ref === null ? undefined : change.key ?? `data-card:${change.ref.id}`;
    case 'removeCombatant':
    case 'setCharacterGuidance':
    case 'assignTeam':
      return change.combatantKey;
    case 'removeAuxScenario':
      return change.scenarioKey;
    case 'removeMaterial':
      return change.materialKey;
    case 'reorderCombatants':
    case 'reorderTeams':
    case 'reorderTeamCombatants':
    case 'reorderAuxScenarios':
    case 'reorderMaterials':
      return change.value.join(' → ');
    default:
      return undefined;
  }
};

export type ArenaProposalSelectionDetailsProps = {
  readonly change: ArenaProposalChange;
  readonly className?: string;
};

export const ArenaProposalSelectionDetails = ({
  change,
  className = 'mt-1 block text-xs text-gray-600 dark:text-gray-400',
}: ArenaProposalSelectionDetailsProps) => (
  <span className={className}>
    {arenaProposalExpectedBaseSummary(change)}
    {change.dependsOn?.length ? ` · 依赖 ${change.dependsOn.join('、')}` : ''}
    {change.atomicGroupId ? ` · 联动变更组 ${change.atomicGroupId}` : ''}
  </span>
);

export type ArenaProposalChangeDescriptionProps = {
  readonly change: ArenaProposalChange;
  readonly labels?: ArenaProposalChangeLabels;
  readonly showDetails?: boolean;
};

/** 只读变更文案；选择、权限与写入动作均由宿主负责。 */
export const ArenaProposalChangeDescription = ({
  change,
  labels,
  showDetails = true,
}: ArenaProposalChangeDescriptionProps) => (
  <>
    <span className="font-medium text-gray-950 dark:text-gray-100" title={changeRefTitle(change)}>
      {arenaProposalChangeProposedSummary(change, labels)}
    </span>
    {showDetails ? <ArenaProposalSelectionDetails change={change} /> : null}
  </>
);
