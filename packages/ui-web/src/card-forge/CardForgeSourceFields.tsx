export interface CardForgeSourceFieldsProps {
  sourceCardJson: string;
  customInstructions: string;
  onSourceCardJsonChange: (value: string) => void;
  onCustomInstructionsChange: (value: string) => void;
  disabled?: boolean;
  sourcePlaceholder?: string;
}

/** 两端同一源卡输入；文件、卡库与执行能力由宿主装配。 */
export function CardForgeSourceFields({ sourceCardJson, customInstructions, onSourceCardJsonChange, onCustomInstructionsChange, disabled, sourcePlaceholder = '可直接粘贴角色卡 / 情景卡 JSON，也可从本地文件或线上数据卡填入' }: CardForgeSourceFieldsProps) {
  return <fieldset disabled={disabled} className="space-y-3 min-w-0">
    <label className="block input-label">源数据卡 JSON
      <textarea aria-label="源数据卡 JSON" value={sourceCardJson} onChange={event => onSourceCardJsonChange(event.target.value)} placeholder={sourcePlaceholder} className="input-field w-full font-mono text-xs resize-y min-h-48" rows={10} />
    </label>
    <label className="block input-label text-xs">附加要求（可选）
      <textarea aria-label="附加要求（可选）" value={customInstructions} onChange={event => onCustomInstructionsChange(event.target.value)} placeholder="例如：希望这张卡偏向控制型、稀有度至少为史诗…" className="input-field w-full text-sm resize-y" rows={2} />
    </label>
  </fieldset>;
}
