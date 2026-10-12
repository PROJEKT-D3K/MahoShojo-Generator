import type { MagicTeaPartySessionExport } from '@mahoshojo/domain/magic-tea-party/transfer';

export {
  buildMagicTeaPartySessionExport,
  parseSillyTavernJsonl,
  stringifySillyTavernJsonl,
} from '@mahoshojo/domain/magic-tea-party/transfer';
export type {
  MagicTeaPartySessionExport,
  MagicTeaPartyArchiveExport,
} from '@mahoshojo/domain/magic-tea-party/transfer';

export type MagicTeaPartyArchiveZipManifest = {
  schema: 'magic-tea-party.archive.zip.v1';
  exportedAt: string;
  appVersion?: string;
  sessionCount: number;
  tachieCount: number;
  missingBlobs: number;
};

export type MagicTeaPartyArchiveZipResult = {
  entries: Record<string, Uint8Array>;
  manifest: MagicTeaPartyArchiveZipManifest;
  tachieIndex: Array<Record<string, unknown>>;
  stats: { sessionCount: number; blobCount: number; missingCount: number };
};

const encodeJson = (payload: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(payload, null, 2));

export const getMagicTeaPartyBlobExtension = (blob: Blob | null): { ext: string; mime: string } => {
  if (!blob) return { ext: 'bin', mime: 'application/octet-stream' };
  const mime = blob.type || 'application/octet-stream';
  if (mime.includes('png')) return { ext: 'png', mime };
  if (mime.includes('jpeg') || mime.includes('jpg')) return { ext: 'jpg', mime };
  if (mime.includes('webp')) return { ext: 'webp', mime };
  if (mime.includes('gif')) return { ext: 'gif', mime };
  return { ext: 'bin', mime };
};

export const buildMagicTeaPartyArchiveZipEntries = async (params: {
  sessions: MagicTeaPartySessionExport[];
  tachieBlobs: Record<string, Blob | null>;
  exportedAt?: string;
  appVersion?: string;
}): Promise<MagicTeaPartyArchiveZipResult> => {
  const entries: Record<string, Uint8Array> = {};
  const tachieIndex: Array<Record<string, unknown>> = [];
  let blobCount = 0;
  let missingCount = 0;

  for (const sessionExport of params.sessions) {
    const sessionId = sessionExport.session?.id ? String(sessionExport.session.id) : 'unknown';
    entries[`sessions/${sessionId}.json`] = encodeJson(sessionExport);

    for (const asset of sessionExport.tachieAssets ?? []) {
      const assetId = asset?.id ? String(asset.id) : '';
      if (!assetId) continue;
      const blob = params.tachieBlobs[assetId] ?? null;
      const { ext, mime } = getMagicTeaPartyBlobExtension(blob);
      const fileName = `assets/tachie/${assetId}.${ext}`;
      if (blob) {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        entries[fileName] = buffer;
        blobCount += 1;
        tachieIndex.push({
          ...asset,
          fileName,
          mimeType: mime,
          blobSize: buffer.byteLength,
        });
      } else {
        missingCount += 1;
        tachieIndex.push({
          ...asset,
          fileName: null,
          mimeType: mime,
          blobSize: 0,
        });
      }
    }
  }

  const manifest: MagicTeaPartyArchiveZipManifest = {
    schema: 'magic-tea-party.archive.zip.v1',
    exportedAt: params.exportedAt ?? new Date().toISOString(),
    appVersion: params.appVersion,
    sessionCount: params.sessions.length,
    tachieCount: blobCount,
    missingBlobs: missingCount,
  };

  entries['manifest.json'] = encodeJson(manifest);
  entries['assets/tachie/index.json'] = encodeJson({
    schema: 'magic-tea-party.tachie.index.v1',
    items: tachieIndex,
  });

  return {
    entries,
    manifest,
    tachieIndex,
    stats: {
      sessionCount: params.sessions.length,
      blobCount,
      missingCount,
    },
  };
};
