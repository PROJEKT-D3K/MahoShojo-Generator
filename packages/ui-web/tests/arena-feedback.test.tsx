// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ArenaFeedbackView, resolveArenaFeedbackTone } from '../src/arena/ArenaFeedbackView';
import { ErrorMessageBox } from '../src/details-controls/ErrorMessageBox';

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Arena 操作反馈', () => {
  it.each([
    ['❌ 数据卡 JSON 解析失败', 'error'],
    ['⚠️ 旧版随机事件已忽略', 'warning'],
    ['冷却中，请稍候重试', 'warning'],
    ['未知提示', 'warning'],
    ['✨ 魔法失效了！网络连接中断', 'warning'],
    ['战报已生成，但角色更新失败', 'warning'],
  ] as const)('保持混合反馈槽的兼容分类：%s', (message, tone) => {
    expect(resolveArenaFeedbackTone(message)).toBe(tone);
  });

  it.each(['full', 'lite'] as const)('%s 保留换行、纯文本和宿主帮助插槽', appearance => {
    const message = '❌ 数据卡错误\n<img src="https://invalid.example/tracker">';
    act(() => root.render(
      <ArenaFeedbackView message={message} tone="error" appearance={appearance}>
        <a href="#help">查看百科</a>
      </ArenaFeedbackView>,
    ));
    const alert = container.querySelector('[role=alert]')!;
    expect(alert.classList.contains(`arena-feedback--${appearance}`)).toBe(true);
    expect(alert.classList.contains('arena-feedback--error')).toBe(true);
    expect(alert.classList.contains('error-message')).toBe(false);
    expect(alert.classList.contains('wrap-anywhere')).toBe(true);
    expect(alert.classList.contains('forced-colors:border')).toBe(true);
    expect(alert.querySelector('.whitespace-pre-wrap')?.textContent).toBe(message);
    expect(alert.querySelector('img')).toBeNull();
    expect(alert.querySelector('a')?.getAttribute('href')).toBe('#help');
  });

  it('显式 tone 不受文案推测覆盖，也不改变通用错误框默认', () => {
    act(() => root.render(<ArenaFeedbackView message="无前缀错误" tone="error" appearance="full" />));
    expect(container.innerHTML).toContain('bg-red-100 text-red-800');
    act(() => root.render(<ErrorMessageBox message="保存失败" />));
    expect(container.innerHTML).toContain('class="error-message"');
  });
});
