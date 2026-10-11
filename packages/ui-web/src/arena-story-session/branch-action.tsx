'use client';

export type BattleStoryBranchActionProps = {
  variant: 'tail' | 'selected';
  chapterIndex?: number | null;
  disabled?: boolean;
  title?: string;
  busy?: boolean;
  /** The host owns the countdown; null or undefined means no active cooldown. */
  cooldownSeconds?: number | null;
  onClick(): void;
};

/** Controlled branch entry only; the host owns eligibility, selection and generation. */
export function BattleStoryBranchAction(props: BattleStoryBranchActionProps) {
  const selected = props.variant === 'selected';
  const isCooldown = props.cooldownSeconds != null;
  const label = selected
    ? (props.chapterIndex != null ? `从第 ${props.chapterIndex} 章创建分支` : '从所选章节创建分支')
    : '创建分支';
  const title = props.title ?? (isCooldown
    ? `冷却中，请等待 ${props.cooldownSeconds} 秒`
    : (selected ? '以当前所选章节为锚点创建新分支会话' : '以当前结尾为基础复制一条分支会话'));

  return <button
    type="button"
    data-story-branch-action={props.variant}
    onClick={props.onClick}
    disabled={props.disabled || props.busy || isCooldown}
    aria-busy={props.busy || undefined}
    className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
    title={title}
  >
    {props.busy
      ? (selected ? '正在创建分支...' : '正在分支...')
      : (isCooldown ? `冷却中 ${props.cooldownSeconds}s` : label)}
  </button>;
}
