import { MagicTeaPartyChatComposer as SharedChatComposer, type MagicTeaPartyChatComposerProps } from '@mahoshojo/ui-web/magic-tea-party';

export function MagicTeaPartyChatComposer(props: MagicTeaPartyChatComposerProps) {
  return <SharedChatComposer {...props}
    markdownHint="提示：Markdown 模式正文更自由；合并输出计划设为“强制”时会额外调用生成选项/摘要/更新。"
    overLimitHint="已超出单条预算，发送时会自动保留首尾并省略中段；建议先精简。"
  />;
}
