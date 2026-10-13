import { MagicTeaPartyNoticePanel as SharedNoticePanel, type MagicTeaPartyNoticePanelProps } from '@mahoshojo/ui-web/magic-tea-party';
import { ErrorMessage } from '@/components/ErrorMessage';

export function MagicTeaPartyNoticePanel(props: MagicTeaPartyNoticePanelProps) {
  return <SharedNoticePanel {...props} renderError={(message) => <ErrorMessage message={message}
    className="text-sm" linkClassName="underline underline-offset-2 hover:opacity-95" />} />;
}
