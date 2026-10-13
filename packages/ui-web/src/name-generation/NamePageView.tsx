import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react';
import { nameResultGradient, type NameGenerationResult } from '@mahoshojo/domain/name-generation';
import { capturePngBlob } from '../client/snapdomCapture';
import { ThemeImage } from '../media/ThemeImage';

/** Capture only the product card; always restore each original display value, including failure. */
export async function captureNameResultImage(element: HTMLElement, capture: typeof capturePngBlob = capturePngBlob): Promise<Blob> {
  const actions = [...element.querySelectorAll<HTMLElement>('[data-name-export-action]')];
  const logo = element.querySelector<HTMLElement>('.logo-placeholder');
  const snapshots = [...actions, ...(logo ? [logo] : [])].map(node => ({ node, display: node.style.display }));
  try {
    actions.forEach(node => { node.style.display = 'none'; });
    if (logo) logo.style.display = 'flex';
    return await capture(element, { scale: 1 });
  } finally {
    snapshots.forEach(({ node, display }) => { node.style.display = display; });
  }
}

export interface NamePageViewProps {
  inputName: string;
  selectedLanguage: string;
  languages: readonly { code: string; name: string }[];
  onNameChange: (value: string) => void;
  onLanguageChange: (value: string) => void;
  onGenerate: () => void;
  isGenerating: boolean;
  disabled?: boolean;
  generateDisabled?: boolean;
  generateLabel?: string;
  magicalGirl: NameGenerationResult | null;
  resultRef: RefObject<HTMLDivElement | null>;
  captureImage?: typeof capturePngBlob;
  onSaveImage: (blob: Blob, result: NameGenerationResult) => void | Promise<void>;
  onSaveJson: (result: NameGenerationResult) => void | Promise<void>;
  onExportingChange?: (exporting: boolean) => void;
  assetBaseUrl?: string;
  navigation?: ReactNode;
  configuration?: ReactNode;
  actions?: ReactNode;
  feedback?: ReactNode;
  afterResult?: ReactNode;
  exportBranding?: ReactNode;
  footer?: ReactNode;
}

/** Classic form and registration card, consumed by both runtime adapters. */
export function NamePageView({
  inputName, selectedLanguage, languages, onNameChange, onLanguageChange, onGenerate,
  isGenerating, disabled = false, generateDisabled = false, generateLabel, magicalGirl,
  resultRef, captureImage, onSaveImage, onSaveJson, onExportingChange, assetBaseUrl = '/',
  navigation, configuration, actions, feedback, afterResult, exportBranding, footer,
}: NamePageViewProps) {
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<{ result: NameGenerationResult; message: string } | null>(null);
  const busy = useRef(false);
  const mounted = useRef(false);
  const currentResult = useRef(magicalGirl);
  currentResult.current = magicalGirl;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const canGenerate = !!inputName.trim() && !isGenerating && !disabled && !generateDisabled && !exporting;
  const exportResult = async (kind: 'png' | 'json') => {
    const result = magicalGirl;
    const element = resultRef.current;
    if (!result || !element || busy.current || isGenerating || disabled) return;
    busy.current = true;
    setExporting(true);
    setExportError(null);
    onExportingChange?.(true);
    try {
      if (kind === 'png') {
        const blob = await captureNameResultImage(element, captureImage);
        if (mounted.current && currentResult.current === result) await onSaveImage(blob, result);
      } else await onSaveJson(result);
    } catch (cause) {
      if (mounted.current && currentResult.current === result) setExportError({ result, message: `导出失败，当前结果已保留：${cause instanceof Error ? cause.message : '请重试'}` });
    } finally {
      busy.current = false;
      if (mounted.current) { setExporting(false); onExportingChange?.(false); }
    }
  };
  return (
      <div className="magic-background">
        <div className="container">
          <div className="card">
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', marginBottom: '1rem' }}>
              <ThemeImage lightSrc={`${assetBaseUrl}logo.svg`} darkSrc={`${assetBaseUrl}logo-white.svg`} width={250} height={160} alt="Logo" />
            </div>
            <p className="subtitle text-center">你是什么魔法少女呢！</p>
            {navigation}
            <div className="mt-4 mb-8 text-center">
              <p className="text-sm text-gray-500 italic">本测试设定来源于小说《下班，然后变成魔法少女》</p>
            </div>
            <div className="input-group">
              <label htmlFor="name" className="input-label">
                请输入你的名字：
              </label>
              <input
                id="name"
                type="text"
                value={inputName}
                onChange={(e) => onNameChange(e.target.value)}
                className="input-field"
                placeholder="例如：鹿目圆香"
                disabled={disabled || exporting}
                onKeyDown={(e) => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && !busy.current && canGenerate) onGenerate(); }}
              />
            </div>

            <div className="input-group">
              <label htmlFor="language-select" className="input-label">
                <img src={`${assetBaseUrl}globe.svg`} alt="Language" className="inline-block w-4 h-4 mr-2" />
                生成语言
              </label>
              <select
                id="language-select"
                value={selectedLanguage}
                onChange={(e) => onLanguageChange(e.target.value)}
                className="input-field"
                disabled={disabled || isGenerating || exporting}
              >
                {languages.map(lang => (
                  <option key={lang.code} value={lang.code}>{lang.name}</option>
                ))}
              </select>
            </div>

            {configuration}
            <button
              onClick={() => { if (!busy.current && canGenerate) onGenerate(); }}
              disabled={!canGenerate}
              className="generate-button"
            >
              {generateLabel ?? (isGenerating ? '少女创造中，请稍后捏 (≖ᴗ≖)✧✨' : 'へんしん(ﾉﾟ▽ﾟ)ﾉ! ')}
            </button>
            {actions}
            {feedback}
            {exportError?.result === magicalGirl && <p role="alert">{exportError.message}</p>}
            {magicalGirl && (
              <div
                ref={resultRef}
                className="result-card"
                style={{
                  background: nameResultGradient(magicalGirl)
                }}
              >
                <div className="result-content">
                  <div className="flex justify-center items-center" style={{ marginBottom: '1rem', background: 'transparent' }}>
                    <img src={`${assetBaseUrl}mahou-title.svg`} width={300} height={70} alt="Logo" style={{ display: 'block', background: 'transparent' }} />
                  </div>
                  <div className="result-item">
                    <div className="result-label">✨ 真名解放</div>
                    <div className="result-value">{magicalGirl.realName}</div>
                  </div>
                  <div className="result-item">
                    <div className="result-label">💝 魔法少女名</div>
                    <div className="result-value">
                      {magicalGirl.name}
                      <div style={{ fontStyle: 'italic', marginTop: '8px', fontSize: '14px', opacity: 0.9 }}>
                        「{magicalGirl.flowerDescription}」
                      </div>
                    </div>
                  </div>

                  <div className="result-item">
                    <div className="result-label">👗 外貌</div>
                    <div className="result-value">
                      身高：{magicalGirl.appearance.height}<br />
                      体重：{magicalGirl.appearance.weight}<br />
                      发色：{magicalGirl.appearance.hairColor}<br />
                      发型：{magicalGirl.appearance.hairStyle}<br />
                      瞳色：{magicalGirl.appearance.eyeColor}<br />
                      肤色：{magicalGirl.appearance.skinTone}<br />
                      穿着：{magicalGirl.appearance.wearing}<br />
                      特征：{magicalGirl.appearance.specialFeature}
                    </div>
                  </div>

                  <div className="result-item">
                    <div className="result-label">✨ 变身咒语</div>
                    <div className="result-value">
                      <div style={{ whiteSpace: 'pre-line' }}>{magicalGirl.spell}</div>
                    </div>
                  </div>

                  <div className="result-item">
                    <div className="result-label">⭐ 魔法等级</div>
                    <div className="result-value">
                      <span className="level-badge">
                        {magicalGirl.levelEmoji} {magicalGirl.level}
                      </span>
                    </div>
                  </div>

                  <button onClick={() => { void exportResult('png'); }} disabled={exporting || isGenerating || disabled} data-name-export-action className="save-button">
                    📱 保存为图片
                  </button>

                  <button id="download-json" onClick={() => { void exportResult('json'); }} disabled={exporting || isGenerating || disabled} data-name-export-action className="save-button" style={{ marginTop: '0.5rem', background: 'linear-gradient(135deg, #5c7cfa 0%, #748ffc 100%)' }}>
                    📄 下载设定文件
                  </button>

                  <div
                    className="logo-placeholder"
                    style={{ display: 'none', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', marginTop: '1rem' }}
                  >
                    <img
                      src={`${assetBaseUrl}logo-white-qrcode.svg`}
                      width={240}
                      height={240}
                      alt="Logo"
                      style={{
                        display: 'block',
                        maxWidth: '100%',
                        height: 'auto'
                      }}
                    />
                    {exportBranding}
                  </div>
                </div>
              </div>
            )}

            {afterResult}
          </div>

          {footer}
        </div>

      </div>
  );
}
