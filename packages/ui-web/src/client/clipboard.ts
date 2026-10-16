// 自 `apps/web/lib/clipboard.ts` 上移：剪贴板写文本的 WebView 通用实现
//（navigator.clipboard 优先，失败退回隐藏 textarea + execCommand）。

// 已派发给系统的 writeText 不能撤销；能力围栏阻止后续 fallback 再发起一次写入。
export async function copyTextToClipboard(text: string, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (typeof window === 'undefined' || !isCurrent()) return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // ignore and fallback
  }

  if (!isCurrent()) return false;
  let textArea: HTMLTextAreaElement | null = null;
  try {
    textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.setAttribute('readonly', 'true');
    textArea.style.position = 'fixed';
    textArea.style.top = '0';
    textArea.style.left = '0';
    textArea.style.opacity = '0';
    document.body.appendChild(textArea);
    textArea.select();
    return isCurrent() && document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textArea?.remove();
  }
}
