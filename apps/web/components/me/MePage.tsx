'use client';

import { useRef, useState } from 'react';
import { MePageFrame, MeRetentionNotice } from '@mahoshojo/ui-web/me';
import { isBattleReportIdentityCurrent, useBattleReportIdentity } from './battle-report-reader';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useMutation } from '@tanstack/react-query';

import type { NewsReport } from '@/components/BattleReportCard';
import Footer from '@/components/Footer';
import { BattleReportCardModal } from '@/components/me/BattleReportCardModal';
import { BattleReportDetailsModal } from '@/components/me/BattleReportDetailsModal';
import { BattleReportsPanel } from '@/components/me/BattleReportsPanel';
import { ProfileHeader } from '@/components/me/ProfileHeader';
import { ProfileCardModal } from '@/components/me/ProfileCardModal';
import { useGenerationApiIntentLatch } from '@/lib/use-generation-api-intent-latch';
import { useAuth } from '@/lib/useAuth';

// `/me` 旧深链（`?tab=settings` / `?token=`）兼容已上移到
// `app/me/page.tsx` 的服务端早截获——敏感参数不进客户端生命周期。
const LEGACY_ME_SETTINGS_TARGET = '/settings?section=account';

function MePageForIdentity() {
  const reportIdentity = useBattleReportIdentity();
  const activeScope = useRef(reportIdentity.scope);
  activeScope.current = reportIdentity.scope;
  const [reportOwnerScope, setReportOwnerScope] = useState<string | null>(null);
  const generationApiIntentLatch = useGenerationApiIntentLatch();
  const router = useRouter();
  const { user, userBadges, isAuthenticated, loading } = useAuth();

  const [activeReportId, setActiveReportId] = useState<string | null>(null);
  const [showReportDetails, setShowReportDetails] = useState(false);

  const [generated, setGenerated] = useState<{
    report: NewsReport;
    generationId?: string;
    generationMode?: string | null;
    liveBody?: string;
  } | null>(null);
  const [showCardModal, setShowCardModal] = useState(false);

  const [showProfileCardModal, setShowProfileCardModal] = useState(false);

  const regenerateMutation = useMutation({
    mutationFn: async (generationId: string) => {
      const identity = reportIdentity;
      if (!isBattleReportIdentityCurrent(identity.user)) throw new Error('账号已变化，请重新载入战报');
      const generationIntent = generationApiIntentLatch.tryAcquire();
      if (!generationIntent) throw new Error('已有生成请求正在处理中，请勿重复提交。');
      const res = await generationIntent.dispatch(`/api/me/battle-reports/${generationId}/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || '重新生成失败');
      if (!isBattleReportIdentityCurrent(identity.user) || activeScope.current !== identity.scope) throw new Error('账号已变化，旧战报结果已忽略');
      return { data: data as { report: NewsReport; liveBody?: string; generationId?: string; generationMode?: string | null }, identity };
    },
    onSuccess: ({ data, identity }) => {
      if (!isBattleReportIdentityCurrent(identity.user) || activeScope.current !== identity.scope) return;
      setReportOwnerScope(identity.scope);
      setGenerated(data);
      setShowCardModal(true);
    },
  });


  return (
    <>
      <MePageFrame
        navigation={<><Link href="/settings" className="text-sm text-blue-600 hover:underline">设置</Link><Link href="/" className="text-sm text-blue-600 hover:underline">返回首页</Link></>}
        sessionStatus={loading ? <div className="text-sm text-gray-600">加载中…</div> : !isAuthenticated ? <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">
          你尚未登录。请先前往 <Link href="/character-manager" className="underline">角色管理器</Link> 完成登录后再访问个人页。
        </div> : null}
        profile={!loading && isAuthenticated && user ? <ProfileHeader user={user} badges={userBadges} onOpenSettings={() => router.push(LEGACY_ME_SETTINGS_TARGET)} onOpenProfileCard={() => setShowProfileCardModal(true)} /> : null}
        notice={<MeRetentionNotice>建议保存战报卡片图片/Markdown 作为留档。</MeRetentionNotice>}
        footer={<Footer />}
      >
        <div>
          <h2 className="text-sm font-semibold text-gray-700">战报记录</h2>
          <div className="mt-2">
            <BattleReportsPanel
              isAuthenticated={Boolean(isAuthenticated)}
              onOpenDetails={(generationId) => {
                setReportOwnerScope(reportIdentity.scope);
                setActiveReportId(generationId);
                setShowReportDetails(true);
              }}
              onRegenerate={(generationId) => regenerateMutation.mutate(generationId)}
              isRegenerating={regenerateMutation.isPending}
              regenerateError={regenerateMutation.error ? (regenerateMutation.error as Error).message : null}
            />
          </div>
        </div>
      </MePageFrame>

      <BattleReportDetailsModal
        isOpen={showReportDetails && reportOwnerScope === reportIdentity.scope}
        ownerScope={reportOwnerScope}
        generationId={activeReportId}
        onClose={() => setShowReportDetails(false)}
        onRegenerate={(generationId) => regenerateMutation.mutate(generationId)}
        isRegenerating={regenerateMutation.isPending}
        regenerateError={regenerateMutation.error ? (regenerateMutation.error as Error).message : null}
      />

      <BattleReportCardModal
        isOpen={showCardModal && reportOwnerScope === reportIdentity.scope}
        generationId={generated?.generationId ?? null}
        generationMode={generated?.generationMode ?? null}
        report={generated?.report ?? null}
        liveBody={generated?.liveBody ?? null}
        onClose={() => setShowCardModal(false)}
      />

      <ProfileCardModal isOpen={showProfileCardModal} onClose={() => setShowProfileCardModal(false)} />
    </>
  );
}

export function MePage() {
  const { scope } = useBattleReportIdentity();
  return <MePageForIdentity key={scope ?? "signed-out"} />;
}
