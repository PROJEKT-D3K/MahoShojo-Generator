import { useResultJsonCopy } from './use-result-json-copy';

export interface ResultJsonCopyButtonProps {
  data: unknown;
  className?: string;
  onResult: (copied: boolean) => void;
}

/** 操作意图跟随实际结果按钮挂载，隐藏结果不会保留后台复制能力。 */
export function ResultJsonCopyButton({ data, className, onResult }: ResultJsonCopyButtonProps) {
  const { copyJson } = useResultJsonCopy(data, { onResult });
  return <button type="button" className={className} onClick={() => void copyJson()}>复制到剪贴板</button>;
}
