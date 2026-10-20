import type { ReactNode } from 'react';

import { ErrorMessageBox } from '../details-controls/ErrorMessageBox';

export type ArenaFeedbackTone = 'error' | 'warning';
export type ArenaFeedbackAppearance = 'full' | 'lite';

export interface ArenaFeedbackViewProps {
  message: string;
  tone: ArenaFeedbackTone;
  appearance: ArenaFeedbackAppearance;
  /** 百科链接等附属内容由宿主提供，视图不取得导航或执行能力。 */
  children?: ReactNode;
}

/**
 * 兼容 Arena 既有混合反馈槽：❌ 为错误，其余为提醒（包括魔法失效与战后附加失败）。
 * 不按生成 phase 重分类，也不改写消息；新调用方可直接为视图提供明确的 tone。
 */
export function resolveArenaFeedbackTone(message: string): ArenaFeedbackTone {
  return message.startsWith('❌') ? 'error' : 'warning';
}

const FULL_TONE_CLASSES: Record<ArenaFeedbackTone, string> = {
  error: 'bg-red-100 text-red-800',
  warning: 'bg-yellow-100 text-yellow-800',
};

/** 两端操作区共用 Web 的紧凑反馈；full 保留既有色板，lite 消费 battle-lite 的亮暗 token。 */
export function ArenaFeedbackView({ message, tone, appearance, children }: ArenaFeedbackViewProps) {
  const toneClass = appearance === 'lite'
    ? `battle-lite-alert battle-lite-alert--${tone}`
    : FULL_TONE_CLASSES[tone];
  return (
    <ErrorMessageBox
      message={message}
      className={`arena-feedback arena-feedback--${appearance} arena-feedback--${tone} mt-3 min-w-0 rounded-md p-4 text-left text-sm wrap-anywhere forced-colors:border ${toneClass}`}
    >
      {children}
    </ErrorMessageBox>
  );
}
