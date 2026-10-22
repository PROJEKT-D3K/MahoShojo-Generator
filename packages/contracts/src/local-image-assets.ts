import { z } from './zod';
import { utf8ByteLimitedStringSchema } from './wire-size';

export const LOCAL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const LOCAL_IMAGE_MAX_EDGE = 8192;
export const LOCAL_IMAGE_MAX_PIXELS = 16 * 1024 * 1024;
export const LocalImageIdSchema = z.string().regex(/^image-[a-f0-9]{64}$/u);
export const LocalImageDigestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
export const LocalImageMimeSchema = z.enum(['image/png', 'image/jpeg', 'image/webp']);
export const LocalImageTitleSchema = utf8ByteLimitedStringSchema(240).refine(
  value => value.length > 0 && value.trim() === value && !/[\u0000-\u001f\u007f]/u.test(value),
  '图片名称不能为空、包含控制字符或首尾空白',
);
export const LocalImageAssetSchema = z.object({
  schemaVersion: z.literal(1),
  id: LocalImageIdSchema,
  digest: LocalImageDigestSchema,
  title: LocalImageTitleSchema,
  mimeType: LocalImageMimeSchema,
  byteLength: z.number().int().positive().max(LOCAL_IMAGE_MAX_BYTES),
  width: z.number().int().positive().max(LOCAL_IMAGE_MAX_EDGE),
  height: z.number().int().positive().max(LOCAL_IMAGE_MAX_EDGE),
  createdAt: z.string().datetime({ offset: true }),
  deletedAt: z.string().datetime({ offset: true }).nullable(),
  source: z.literal('uploaded'),
}).strict().refine(value => value.width * value.height <= LOCAL_IMAGE_MAX_PIXELS, '图片像素超限')
  .refine(value => value.id === `image-${value.digest.slice(7)}`, '图片身份与摘要不符');
export type LocalImageAsset = z.infer<typeof LocalImageAssetSchema>;

export const LocalImageListRequestSchema = z.object({
  view: z.enum(['active', 'trash']), limit: z.number().int().min(1).max(100), cursor: LocalImageIdSchema.nullable(),
}).strict();
export type LocalImageListRequest = z.infer<typeof LocalImageListRequestSchema>;
export const LocalImagePageSchema = z.object({
  items: z.array(LocalImageAssetSchema).max(100), nextCursor: LocalImageIdSchema.nullable(),
}).strict();
export type LocalImagePage = z.infer<typeof LocalImagePageSchema>;
export const LocalImageIdRequestSchema = z.object({ id: LocalImageIdSchema }).strict();
export const LocalImagePayloadSchema = z.object({
  encoding: z.literal('base64'),
  data: z.string().min(4).max(Math.ceil(LOCAL_IMAGE_MAX_BYTES / 3) * 4)
    .regex(/^[A-Za-z0-9+/]*={0,2}$/u),
  byteLength: z.number().int().positive().max(LOCAL_IMAGE_MAX_BYTES),
}).strict().refine(value => value.data.length % 4 === 0 && value.data.length / 4 * 3 - (value.data.endsWith('==') ? 2 : value.data.endsWith('=') ? 1 : 0) === value.byteLength,
  '图片传输长度不符');
export const LocalImageSaveRequestSchema = z.object({ title: LocalImageTitleSchema, payload: LocalImagePayloadSchema }).strict();
export const LocalImageSaveResultSchema = z.object({
  asset: LocalImageAssetSchema, outcome: z.enum(['stored', 'already-present', 'repaired']),
}).strict();
export type LocalImageSaveResult = z.infer<typeof LocalImageSaveResultSchema>;
export const LocalImageExportResultSchema = z.object({ absolutePath: z.string().min(1), byteLength: z.number().int().positive().max(LOCAL_IMAGE_MAX_BYTES) }).strict();
export const LocalImageErrorSchema = z.object({
  code: z.enum(['image-invalid-input', 'image-too-large', 'image-unsupported', 'image-decode-failed',
    'image-not-found', 'image-corrupt', 'image-not-deleted', 'image-unavailable', 'image-failed', 'maintenance-busy', 'restore-pending']),
  message: z.string(),
}).strict();
