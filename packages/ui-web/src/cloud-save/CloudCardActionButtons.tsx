import type { ReactNode } from 'react';
import { GenerationActionButton } from '../generation-actions';

export interface CloudCardActionButtonsProps {
  saveLabel?: ReactNode;
  saveDisabled?: boolean;
  replaceDisabled?: boolean;
  onSave: () => void;
  onReplace: () => void;
}

/** 只共享生成结果的按钮呈现，确认、重试与反馈仍由宿主 adapter 持有。 */
export function CloudCardActionButtons({ saveLabel = '保存到云端', saveDisabled, replaceDisabled, onSave, onReplace }: CloudCardActionButtonsProps) {
  return <div className="flex flex-col gap-2 md:flex-row" data-testid="cloud-card-action-buttons">
    <GenerationActionButton variant="primary" className="flex-1" disabled={saveDisabled} onClick={onSave}>{saveLabel}</GenerationActionButton>
    <GenerationActionButton className="flex-1" disabled={replaceDisabled} onClick={onReplace}>替换已有</GenerationActionButton>
  </div>;
}

export function CloudCardActionFeedback({ children }: { children: ReactNode }) {
  return <div className="space-y-2 text-sm" data-testid="cloud-card-action-feedback">{children}</div>;
}
