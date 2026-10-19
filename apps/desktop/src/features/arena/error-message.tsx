import { ErrorMessageBox } from '@mahoshojo/ui-web/details-controls';
import { getEncyclopediaHelpForError } from '@mahoshojo/ui-web/error-help';
import { useRouter } from '@tanstack/react-router';
import { navigateByProductHref, resolveInternalHrefForHashHistory } from '../../app/hash-history-fragment';

/** 共用 Web 错误框和百科规则，仅站内导航由 Desktop 适配。 */
export function DesktopArenaErrorMessage({ message, generation = false }: { message: string; generation?: boolean }) {
  const router = useRouter();
  const displayed = generation && !message.includes('魔法失效') ? `✨ 魔法失效了！${message}` : message;
  const help = getEncyclopediaHelpForError({ message: displayed });
  const href = help ? `/encyclopedia/${help.slug}` : null;
  return <ErrorMessageBox message={displayed}>{help && href ? <div className="mt-2 text-xs opacity-95">
    <a href={resolveInternalHrefForHashHistory(href)} className="underline underline-offset-2 hover:opacity-100"
      onClick={event => { event.preventDefault(); navigateByProductHref(router, href); }}>查看百科：{help.title}</a>
  </div> : null}</ErrorMessageBox>;
}
