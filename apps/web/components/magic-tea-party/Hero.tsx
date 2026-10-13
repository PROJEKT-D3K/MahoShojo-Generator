import Link from 'next/link';
import { MagicTeaPartyHero as SharedHero } from '@mahoshojo/ui-web/magic-tea-party';
import { ErrorMessage } from '@/components/ErrorMessage';

export function MagicTeaPartyHero({ globalError }: { globalError: string | null }) {
  return <SharedHero
    globalError={globalError}
    description="聊天记录保存在本地浏览器；魔法茶会仅支持自备 API Key。"
    homeLink={<Link href="/" className="text-sm text-pink-700 hover:underline">返回首页</Link>}
    renderError={(message) => <ErrorMessage message={message}
      className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700"
      linkClassName="text-red-700 underline underline-offset-2 hover:opacity-95" />}
  />;
}
