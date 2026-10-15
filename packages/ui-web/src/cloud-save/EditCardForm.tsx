import React from 'react';
import type { OwnedCardMetadataDraft } from './owned-card-metadata';
import { AlertTriangle } from 'lucide-react';
import { getDataCardStatus } from '../card-library/status';
import { inferDataCardTemplate as inferTemplate, DATA_CARD_TEMPLATE_LABELS as TEMPLATE_LABELS, type InferableDataCardTemplate as InferableTemplate } from '@mahoshojo/domain/data-cards';

interface EditCardFormProps {
  card: any;
  onSave: (name: string, description: string, isPublic: number) => void;
  onCancel: () => void;
  cancelLabel?: string;
  showTemplate?: boolean;
  value?: OwnedCardMetadataDraft;
  onChange?: (value: OwnedCardMetadataDraft) => void;
  busy?: boolean;
  submitDisabled?: boolean;
  error?: string | null;
  supplementaryContent?: React.ReactNode;
}

export default function EditCardForm({ card, onSave, onCancel, cancelLabel = '取消', showTemplate = true, value, onChange, busy = false, submitDisabled = false, error, supplementaryContent }: EditCardFormProps) {
  const cardStatus = getDataCardStatus(card).status;
  const isBanned = value?.isPublic === -1 || cardStatus === 'banned';
  const [localFormData, setLocalFormData] = React.useState({
    name: card.name,
    description: card.description || '',
    isPublic: cardStatus === 'public' // 只在公开状态下显示为选中
  });

  const formData = value ? { ...value, isPublic: value.isPublic === 1 } : localFormData;
  const setFormData = (next: typeof localFormData) => {
    if (value && onChange) onChange({ ...next, isPublic: isBanned ? -1 : next.isPublic ? 1 : 0 });
    else setLocalFormData(next);
  };

  const templateType = React.useMemo<InferableTemplate>(() => {
    if (!showTemplate) return 'unknown';
    try {
      const parsed = JSON.parse(card.data);
      return inferTemplate(parsed);
    } catch {
      return 'unknown';
    }
  }, [card.data, showTemplate]);

  const templateLabel = templateType === 'unknown' ? '未知类型' : TEMPLATE_LABELS[templateType];

  return (
    <div className="border rounded-lg p-4">
      <fieldset disabled={busy} className="space-y-2">
        <input
          type="text"
          aria-label="名称"
          value={formData.name}
          onChange={(e) => setFormData({ ...formData, name: e.target.value })}
          className="input-field"
          placeholder="名称"
          maxLength={20}
        />
        <textarea
          aria-label="描述"
          value={formData.description}
          onChange={(e) => setFormData({ ...formData, description: e.target.value })}
          className="input-field text-sm"
          rows={2}
          placeholder="描述"
          maxLength={300}
        />
        {showTemplate && <div>
          <label className="block text-sm font-medium text-gray-700">内容模板</label>
          <select
            value={templateType === 'unknown' ? '__unknown__' : templateType}
            disabled
            className="input-field bg-gray-100 cursor-not-allowed"
          >
            <option value={templateType === 'unknown' ? '__unknown__' : templateType}>
              {templateLabel}
            </option>
          </select>
          <p className="mt-1 text-xs text-gray-500">
            如需转换模板，请在档案馆编辑器中载入该数据卡并使用“内容模板”选择器。
          </p>
        </div>}
        <div className="flex items-center gap-2">
          <input
            type="checkbox"
            id={`card-public-${card.id}`}
            checked={formData.isPublic}
            onChange={(e) => !isBanned && setFormData({ ...formData, isPublic: e.target.checked })}
            disabled={isBanned}
            className={`w-4 h-4 rounded ${isBanned ? 'opacity-50 cursor-not-allowed' : 'text-purple-600'
              }`}
          />
          {!isBanned && <label htmlFor={`card-public-${card.id}`} className={`text-sm flex items-center gap-1 ${isBanned ? 'text-red-600' : 'text-gray-700'
            }`}>
            设为公开
          </label>}
          {isBanned && (
            <div className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-1 rounded">
              <AlertTriangle className="w-3 h-3" />
              数据卡已被封禁，无法修改公开状态
            </div>
          )}
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        {supplementaryContent}
        <div className="flex gap-2">
          <button
            disabled={busy || submitDisabled}
            onClick={() => onSave(formData.name, formData.description, isBanned ? -1 : (formData.isPublic ? 1 : 0))}
            className="px-3 py-1 bg-green-600 text-white rounded text-sm hover:bg-green-700"
          >
            {busy ? '处理中…' : '保存'}
          </button>
          <button
            onClick={onCancel}
            className="px-3 py-1 bg-gray-500 text-white rounded text-sm hover:bg-gray-600"
          >
            {cancelLabel}
          </button>
        </div>
      </fieldset>
    </div>
  );
}
