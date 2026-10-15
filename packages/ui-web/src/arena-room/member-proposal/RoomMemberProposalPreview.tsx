import type { ArenaProposalChange } from '@mahoshojo/contracts/arena-room';
import { buttonClassName } from '../../card-library/Button';
import { ArenaProposalSelectionDetails, arenaProposalChangeProposedSummary, changeRefTitle, type ArenaProposalChangeLabels } from '../proposal-presentation';
import { arenaProposalSelectionError } from '../RoomProposalHostReview';
import { MemberProposalDialog } from './MemberProposalDialog';

export const RoomMemberProposalPreview = ({
  changes,
  labels,
  selected,
  disabled,
  onSelectedChange,
  onClose,
  onSubmit,
}: {
  readonly changes: readonly ArenaProposalChange[];
  readonly labels: ArenaProposalChangeLabels;
  readonly selected: ReadonlySet<string>;
  readonly disabled: boolean;
  readonly onSelectedChange: (value: ReadonlySet<string>) => void;
  readonly onClose: () => void;
  readonly onSubmit: () => void;
}) => {
  const validationError = arenaProposalSelectionError(changes, selected);
  return (
    <MemberProposalDialog
      open
      titleId="arena-proposal-preview-heading"
      title="预览提案"
      description="逐项检查后将提交给房主审阅；相关联的修改会一起校验。"
      onClose={onClose}
      widthClassName="max-w-3xl"
    >
        <fieldset className="space-y-2">
          <legend className="sr-only">选择提交变更</legend>
          {changes.map((change) => (
            <label key={change.changeId} className="flex items-start gap-2 rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
              <input
                type="checkbox"
                className="mt-1"
                checked={selected.has(change.changeId)}
                onChange={(event) => {
                  const next = new Set(selected);
                  if (event.target.checked) next.add(change.changeId);
                  else next.delete(change.changeId);
                  onSelectedChange(next);
                }}
              />
              <span>
                <span
                  className="font-medium text-gray-950 dark:text-gray-100"
                  title={changeRefTitle(change)}
                >
                  {arenaProposalChangeProposedSummary(change, labels)}
                </span>
              </span>
            </label>
          ))}
        </fieldset>
        <details className="mt-3">
          <summary className="cursor-pointer select-none text-xs text-gray-600 dark:text-gray-400">技术详情</summary>
          <div className="mt-2 space-y-1.5 text-xs text-gray-600 dark:text-gray-400">
            {changes.map((change) => (
              <p key={`detail-${change.changeId}`}>
                <span className="font-mono">{change.changeId}</span>
                {' · '}
                <ArenaProposalSelectionDetails change={change} />
              </p>
            ))}
          </div>
        </details>
        <div className="mt-4 border-t pt-4 dark:border-gray-800">
          <div className="text-xs text-gray-600 dark:text-gray-400">将提交 {selected.size} / {changes.length} 项变更</div>
          <div aria-live="polite" className="mt-1 min-h-5 text-xs text-red-700 dark:text-red-300">{validationError ?? ''}</div>
          <button
            type="button"
            className={buttonClassName({ variant: 'primary', className: 'mt-2' })}
            disabled={disabled || Boolean(validationError)}
            onClick={onSubmit}
          >
            提交提案
          </button>
        </div>
    </MemberProposalDialog>
  );
};
