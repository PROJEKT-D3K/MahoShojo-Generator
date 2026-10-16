import type { ChangeEventHandler, ReactNode } from 'react';

export interface SublimationSourceInputProps {
  accept: string;
  onFileChange: ChangeEventHandler<HTMLInputElement>;
  loadedSource?: ReactNode;
  pasteOpen: boolean;
  onPasteOpenChange: (open: boolean) => void;
  pasteValue: string;
  onPasteValueChange: (value: string) => void;
  onPasteLoad: () => void;
  loadDisabled: boolean;
}

/** 文件读取、输入重置、解析与草稿均由宿主拥有；这里只转交显式操作。 */
export function SublimationSourceInput({
  accept, onFileChange, loadedSource, pasteOpen, onPasteOpenChange,
  pasteValue, onPasteValueChange, onPasteLoad, loadDisabled,
}: SublimationSourceInputProps) {
  return <>
    <div className="input-group">
      <label htmlFor="character-upload" className="input-label">上传设定文件</label>
      <input
        id="character-upload" type="file" accept={accept} onChange={onFileChange}
        className="input-field file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100"
      />
      {loadedSource}
    </div>
    <div className="mb-6">
      <button
        type="button"
        aria-expanded={pasteOpen}
        aria-controls="sublimation-source-paste"
        onClick={() => onPasteOpenChange(!pasteOpen)}
        className="text-purple-700 hover:underline cursor-pointer mb-2 font-semibold"
      >
        {pasteOpen ? '▼ 折叠文本粘贴区域' : '▶ 展开文本粘贴区域 (手机端推荐)'}
      </button>
      {pasteOpen && <div id="sublimation-source-paste" className="input-group mt-2">
        <label htmlFor="source-json" className="sr-only">设定 JSON</label>
        <textarea
          id="source-json" value={pasteValue} onChange={(event) => onPasteValueChange(event.target.value)}
          placeholder="在此处粘贴一个设定文件(.json)内容" className="input-field resize-y h-32"
        />
        <button
          type="button" onClick={onPasteLoad} disabled={loadDisabled} className="generate-button mt-2 mb-0"
          style={{ backgroundColor: '#8b5cf6', backgroundImage: 'linear-gradient(to right, #8b5cf6, #a78bfa)' }}
        >从文本加载设定</button>
      </div>}
    </div>
  </>;
}
