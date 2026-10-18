'use client';

import type { ReactNode, RefObject } from 'react';
import { buttonClassName } from '../card-library/Button';
import type { RoomGenerationView } from './generation-view';
import {
  arenaRoomGenerationErrorCopy,
  arenaRoomGenerationGapNotice,
  arenaRoomGenerationRecoveryCode,
  arenaRoomGenerationRecoveryNotice,
  arenaRoomGenerationStatusLabel,
  arenaRoomGenerationUnknownNotice,
  isArenaRoomGenerationRecoveryCode,
} from './generation-copy';

export type RoomGenerationResultProps = {
  readonly generation: RoomGenerationView;
  /** The host supplies the existing report renderer and its media/link capabilities. */
  readonly report: ReactNode;
  readonly resultRef?: RefObject<HTMLElement | null>;
  readonly onRetry?: () => void | Promise<void>;
  /** A host may further restrict recovery; this never enables a hidden retry. */
  readonly retryDisabled?: boolean;
};

/** Shared current-generation shell. It never starts, reads or cancels a generation. */
export const RoomGenerationResult = ({ generation, report, resultRef, onRetry, retryDisabled }: RoomGenerationResultProps) => {
  if (generation.phase === 'idle' && !generation.markdown) return null;

  const statusLabel = arenaRoomGenerationStatusLabel(generation);
  const recoveryNotice = arenaRoomGenerationRecoveryNotice(generation);
  const recoveryCode = arenaRoomGenerationRecoveryCode(generation);
  const generationErrorCode = generation.errorCode
    && !isArenaRoomGenerationRecoveryCode(generation.errorCode)
    ? generation.errorCode
    : null;
  const errorCopy = generationErrorCode ? arenaRoomGenerationErrorCopy(generationErrorCode) : null;
  const canRetryRecovery = Boolean(onRetry)
    && !retryDisabled
    && recoveryCode !== null
    && recoveryCode !== 'ROOM_GENERATION_RECOVERY_NOT_FOUND'
    && generation.phase !== 'resyncing';

  return (
    <section
      ref={resultRef}
      aria-labelledby="arena-room-generation-heading"
      className="rounded-xl border border-fuchsia-200 bg-white/80 p-4 dark:border-fuchsia-900 dark:bg-gray-900/70"
      data-arena-room-generation-report="v1"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="arena-room-generation-heading" className="text-sm font-semibold text-gray-950 dark:text-gray-100">
          房间战报
        </h3>
        <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium border-fuchsia-300 text-fuchsia-900 dark:border-fuchsia-700 dark:text-fuchsia-100">{statusLabel}</span>
      </div>
      {generation.phase === 'unknown' ? (
        <p role="status" className="mt-3 text-sm text-amber-800 dark:text-amber-200">
          {arenaRoomGenerationUnknownNotice}
        </p>
      ) : null}
      {generation.gap ? (
        <p role="status" className="mt-3 text-sm text-amber-800 dark:text-amber-200">
          {arenaRoomGenerationGapNotice}
        </p>
      ) : null}
      {recoveryNotice ? (
        <p role="status" className="mt-3 text-sm text-amber-800 dark:text-amber-200">
          {recoveryNotice}
        </p>
      ) : null}
      {canRetryRecovery ? (
        <div className="flex flex-wrap items-center gap-2 mt-3">
          <button
            type="button"
            className={buttonClassName()}
            onClick={() => { void onRetry?.(); }}
          >
            重新同步战报
          </button>
        </div>
      ) : null}
      {errorCopy ? (
        <div role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300" data-generation-error-code={generationErrorCode}>
          <p>{errorCopy.message}</p>
          <details className="mt-1 text-xs opacity-80">
            <summary className="cursor-pointer select-none">技术详情</summary>
            <p className="mt-1">错误代码：{generationErrorCode}</p>
          </details>
        </div>
      ) : null}
      {generation.phase !== 'unknown' && (
        generation.markdown
        || generation.phase === 'running'
        || generation.phase === 'starting'
        || generation.phase === 'resyncing'
        || generation.phase === 'completed'
      ) ? (
        report
      ) : ['starting', 'running'].includes(generation.phase) ? (
        <p className="mt-3 text-sm text-gray-600 dark:text-gray-400">等待服务器发布战报内容…</p>
      ) : null}
      {generation.finalAuthoritative && generation.generationRecordId ? (
        <p className="mt-3 text-xs text-gray-500 dark:text-gray-400">
          最终内容已从生成记录恢复并核验。
        </p>
      ) : null}
    </section>
  );
};
