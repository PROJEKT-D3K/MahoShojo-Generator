import type { ReactNode } from 'react';
import { getCreatorResultBattleLinkText, type CreatorResultKind } from './result-follow-up';

export interface CreatorResultFollowUpProps {
  resultKind: CreatorResultKind;
  renderBattleLink: (props: { href: '/battle'; className: string; children: ReactNode }) => ReactNode;
  additionalActions?: ReactNode;
}

export function CreatorResultFollowUp({ resultKind, renderBattleLink, additionalActions }: CreatorResultFollowUpProps) {
  const structured = resultKind === 'magical-girl' || resultKind === 'canshou';
  return (
    <section aria-label="继续创作" className="mt-2 pt-6 border-t border-gray-200 text-center">
      <p className="text-sm text-gray-600 mb-2">{structured ? '保存好你的设定文件了吗？' : '保存好你的档案了吗？'}</p>
      {renderBattleLink({
        href: '/battle',
        className: `footer-link text-lg ${structured ? 'text-blue-600' : 'text-purple-600'}`,
        children: getCreatorResultBattleLinkText(resultKind),
      })}
      {additionalActions && <div className="mt-3 flex flex-wrap justify-center gap-2">{additionalActions}</div>}
    </section>
  );
}
