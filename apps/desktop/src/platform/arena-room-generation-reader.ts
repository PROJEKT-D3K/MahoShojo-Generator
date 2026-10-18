import {
  DesktopRoomGenerationDescriptorSchema, DesktopRoomGenerationFragmentSchema,
  type DesktopRoomGenerationDescriptor, type DesktopRoomGenerationFragment,
} from '@mahoshojo/contracts/desktop-room-ipc';
import { parseDesktopRoomSessionResponse } from '@mahoshojo/contracts/desktop-room-session';
import type { ArenaRoomGenerationViewResponse } from '@mahoshojo/contracts/arena-room';

export type DesktopGenerationIdentity = {
  readonly roomId: string; readonly roomEpoch: string;
  readonly generationId: string; readonly attempt: number;
};
export class DesktopGenerationReadError extends Error {
  constructor(readonly code: 'invalid-response' | 'scope-changed') { super(code); }
}
export type GenerationDigest = (bytes: Uint8Array<ArrayBuffer>) => Promise<string>;
const sha256: GenerationDigest = async bytes => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), byte => byte.toString(16).padStart(2, '0')).join('');

/** One raw HTTP envelope, retained as fragments until its final delivery. No partial DTO or UI publication. */
export class DesktopGenerationReader {
  private descriptor: DesktopRoomGenerationDescriptor | null = null;
  private fragments: string[] = [];
  private offset = 0;
  private ended = false;
  constructor(private readonly expected: DesktopGenerationIdentity, private readonly viewerUserId: number,
    private readonly isCurrent: () => boolean, private readonly digest: GenerationDigest = sha256) {}
  clear(): void { this.fragments = []; this.ended = true; }
  describe(value: DesktopRoomGenerationDescriptor): void {
    const result = DesktopRoomGenerationDescriptorSchema.safeParse(value);
    if (!result.success || this.descriptor || this.ended) throw new DesktopGenerationReadError('invalid-response');
    const descriptor = result.data;
    if (descriptor.roomId !== this.expected.roomId || descriptor.roomEpoch !== this.expected.roomEpoch
      || descriptor.generationId !== this.expected.generationId || descriptor.attempt !== this.expected.attempt) throw new DesktopGenerationReadError('invalid-response');
    this.descriptor = descriptor;
  }
  async append(value: DesktopRoomGenerationFragment): Promise<ArenaRoomGenerationViewResponse | null> {
    const result = DesktopRoomGenerationFragmentSchema.safeParse(value), descriptor = this.descriptor;
    if (!result.success || !descriptor || this.ended) throw new DesktopGenerationReadError('invalid-response');
    const fragment = result.data;
    if (fragment.requestId !== descriptor.requestId || fragment.offset !== this.offset) throw new DesktopGenerationReadError('invalid-response');
    this.offset += new TextEncoder().encode(fragment.text).byteLength;
    if (this.offset > descriptor.byteLength || fragment.final !== (this.offset === descriptor.byteLength)) throw new DesktopGenerationReadError('invalid-response');
    this.fragments.push(fragment.text);
    if (!fragment.final) return null;
    this.ended = true;
    // Join once. Escaped lone surrogates remain ASCII bytes until JSON.parse, as on HTTP.
    const text = this.fragments.join(''); this.fragments = [];
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength !== descriptor.byteLength) throw new DesktopGenerationReadError('invalid-response');
    const digest = await this.digest(bytes);
    if (!this.isCurrent()) throw new DesktopGenerationReadError('scope-changed');
    if (digest !== descriptor.digest) throw new DesktopGenerationReadError('invalid-response');
    let envelope: ReturnType<typeof parseDesktopRoomSessionResponse<'generationRead'>>;
    try { envelope = parseDesktopRoomSessionResponse('generationRead', JSON.parse(text), this.viewerUserId); }
    catch { throw new DesktopGenerationReadError('invalid-response'); }
    if (!('result' in envelope)) throw new DesktopGenerationReadError('invalid-response');
    const view = envelope.result;
    if (view.roomId !== descriptor.roomId || view.roomEpoch !== descriptor.roomEpoch
      || view.generation.generationId !== descriptor.generationId || view.generation.attempt !== descriptor.attempt) throw new DesktopGenerationReadError('invalid-response');
    if (!this.isCurrent()) throw new DesktopGenerationReadError('scope-changed');
    return view;
  }
}
