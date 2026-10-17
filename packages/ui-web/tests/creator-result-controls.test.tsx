// @vitest-environment jsdom
import { act, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { afterAll, afterEach, expect, test, vi } from 'vitest';
import { CreatorResultPreferences, CreatorResultFollowUp, type CreatorResultKind } from '../src/creator';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const container = document.createElement('div');
document.body.append(container);
const root = createRoot(container);
afterEach(() => act(() => root.render(null)));
afterAll(() => { act(() => root.unmount()); container.remove(); });

function Preferences({ kind }: { kind: CreatorResultKind }) {
  const [imageSaveMode, setImageSaveMode] = useState<'download' | 'modal'>('download');
  const [jsonSaveMode, setJsonSaveMode] = useState<'download' | 'text'>('download');
  const [showDetails, setShowDetails] = useState(false);
  return <CreatorResultPreferences resultKind={kind} imageSaveMode={imageSaveMode} onImageSaveModeChange={setImageSaveMode}
    jsonSaveMode={jsonSaveMode} onJsonSaveModeChange={setJsonSaveMode} recommendedImageMode="download" recommendedJsonMode="download"
    showDetails={showDetails} onToggleDetails={() => setShowDetails(!showDetails)} />;
}

test.each(['magical-girl', 'canshou', 'general', 'general-scenario'] as const)('%s uses the result-specific preferences and field guide', (kind) => {
  act(() => root.render(<Preferences kind={kind} />));
  const structured = kind === 'magical-girl' || kind === 'canshou';
  expect(container.textContent?.includes('设定长图保存方式')).toBe(structured);
  const buttons = () => [...container.querySelectorAll('button')];
  expect(buttons().some(button => button.textContent?.includes('设定说明'))).toBe(kind === 'magical-girl');
  if (structured) {
    const option = buttons().find(button => button.textContent === '复制原始数据')!;
    act(() => option.click());
    expect(option.classList.contains('border-indigo-500')).toBe(true);
  }
  if (kind === 'magical-girl') {
    act(() => buttons().find(button => button.textContent?.includes('设定说明'))!.click());
    expect(container.textContent).toContain('1. 魔力构装');
    act(() => buttons().find(button => button.textContent?.includes('设定说明'))!.click());
    expect(container.textContent).not.toContain('1. 魔力构装');
  }
});

test.each([
  ['magical-girl', '让她大闹一场'], ['canshou', '让它大闹一场'],
  ['general', '让她大闹一场'], ['general-scenario', '把这个情景投入故事'],
] as const)('%s routes through the host and retains additional actions', (resultKind, text) => {
  const navigate = vi.fn();
  act(() => root.render(<CreatorResultFollowUp resultKind={resultKind}
    renderBattleLink={({ href, ...props }) => <a href={href} {...props} onClick={(event) => { event.preventDefault(); navigate(href); }} />}
    additionalActions={<button>前往本地卡库</button>} />));
  const link = container.querySelector('a')!;
  expect(link.textContent).toContain(text);
  act(() => link.click());
  expect(navigate).toHaveBeenCalledExactlyOnceWith('/battle');
  expect(container.querySelector('button')?.textContent).toBe('前往本地卡库');
});
