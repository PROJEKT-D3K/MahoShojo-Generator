import { DESKTOP_ARENA_HOSTED_LIMITS } from '@mahoshojo/contracts/desktop-arena-hosted';
import {
  DesktopArenaHostedStoryRecoveryPointerSchema,
  type DesktopArenaHostedStoryRecoveryPointer,
} from '@mahoshojo/contracts/desktop-arena-story-transport';
import type { GenerationDraftStorage } from '../generation/session';
import { ARENA_HOSTED_RECOVERY_KEYS } from './hosted-recovery';

type Product = keyof typeof ARENA_HOSTED_RECOVERY_KEYS;
export type ArenaHostedStoryRecoveryKind = 'empty' | 'story' | 'foreign' | 'invalid' | 'oversized' | 'unavailable';
export type ArenaHostedStoryRecoveryPatch = Partial<Pick<DesktopArenaHostedStoryRecoveryPointer,
  'generationId' | 'cursor' | 'state' | 'updatedAt'>>;
export interface ArenaHostedStoryRecoveryState {
  readonly pointer: DesktopArenaHostedStoryRecoveryPointer | null;
  /** Exact original string, including whitespace; never a reserialized comparison token. */
  readonly raw: string | null;
  readonly kind: ArenaHostedStoryRecoveryKind;
  readonly pendingRestore: boolean;
  readonly blocked: boolean;
  readonly saved: boolean;
  readonly error: string | null;
}

const empty = (): ArenaHostedStoryRecoveryState => ({
  pointer: null, raw: null, kind: 'empty', pendingRestore: false, blocked: false, saved: true, error: null,
});
const patchKeys = new Set(['generationId', 'cursor', 'state', 'updatedAt']);

/**
 * Only the public v4 pointer. Native owns the actor, claim, funding and pending revision.
 * Neither an empty slot nor a successful write authorizes a Native create or replacement.
 */
export class DesktopArenaHostedStoryRecovery {
  private state: ArenaHostedStoryRecoveryState = empty();
  private readonly listeners = new Set<() => void>();
  private readonly key: string;

  constructor(private readonly storage: GenerationDraftStorage, private readonly product: Product) {
    this.key = ARENA_HOSTED_RECOVERY_KEYS[product];
    this.read();
  }

  private validate(value: unknown): DesktopArenaHostedStoryRecoveryPointer {
    const pointer = DesktopArenaHostedStoryRecoveryPointerSchema.parse(value);
    if (pointer.product !== this.product) throw new Error('pointer product');
    Object.freeze(pointer.actor);
    return Object.freeze(pointer);
  }

  private publish(patch: Partial<ArenaHostedStoryRecoveryState>): ArenaHostedStoryRecoveryState {
    this.state = Object.freeze({ ...this.state, ...patch });
    this.listeners.forEach((listener) => listener());
    return this.state;
  }

  getSnapshot = (): ArenaHostedStoryRecoveryState => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** Explicit reread only; do not silently adopt a concurrent writer before a mutation. */
  read = (): ArenaHostedStoryRecoveryState => {
    let raw: string | null;
    try { raw = this.storage.getItem(this.key); }
    catch {
      return this.publish({ ...empty(), kind: 'unavailable', blocked: true, saved: false,
        error: '故事恢复记录无法读取，未修改原件；请重新读取后再确认恢复身份。' });
    }
    if (raw === null) return this.publish(empty());
    const protectedOriginal = { pointer: null, raw, pendingRestore: false, blocked: true, saved: false } as const;
    if (raw.length > DESKTOP_ARENA_HOSTED_LIMITS.recoveryPointerCodeUnits) {
      return this.publish({ ...protectedOriginal, kind: 'oversized',
        error: '原恢复记录超过读取上限，原件已保留；连续故事不能覆盖或清除此记录。' });
    }
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === 'object' && 'version' in value
        && (value.version === 1 || value.version === 2 || value.version === 3)) {
        return this.publish({ ...protectedOriginal, kind: 'foreign',
          error: '此恢复记录属于单次战报，原件已保留；连续故事不能接管、覆盖或清除此记录。' });
      }
      const pointer = this.validate(value);
      return this.publish({ pointer, raw, kind: 'story', pendingRestore: true, blocked: false, saved: true, error: null });
    } catch {
      return this.publish({ ...protectedOriginal, kind: 'invalid',
        error: '原故事恢复记录无法验证，原件已保留；不能覆盖、修复或清除此记录。' });
    }
  };

  private originalIsCurrent(): boolean {
    try {
      if (this.storage.getItem(this.key) === this.state.raw) return true;
      this.publish({ blocked: true, saved: false,
        error: '本机恢复记录已在外部变化，已保留新原件；请重新读取并核对身份。' });
    } catch {
      this.publish({ blocked: true, saved: false,
        error: '本机恢复记录无法读取，原件已保留；请重新读取并核对身份。' });
    }
    return false;
  }

  private writeEmpty(value: DesktopArenaHostedStoryRecoveryPointer, restoring: boolean): boolean {
    if (this.state.blocked || this.state.kind !== 'empty' || this.state.raw !== null) return false;
    let pointer: DesktopArenaHostedStoryRecoveryPointer;
    try {
      pointer = this.validate(value);
      if (restoring ? pointer.state === 'prepared'
        : pointer.state !== 'prepared' || pointer.generationId !== undefined || pointer.cursor !== undefined) {
        throw new Error('invalid pointer intent');
      }
    } catch {
      this.publish({ saved: false, error: '故事恢复指针不符合协议或操作类型，未写入本机记录。' });
      return false;
    }
    if (!this.originalIsCurrent()) return false;
    try {
      const raw = JSON.stringify(pointer);
      this.storage.setItem(this.key, raw);
      this.publish({ pointer, raw, kind: 'story', pendingRestore: restoring, blocked: false, saved: true, error: null });
      return true;
    } catch {
      this.publish({ saved: false, error: restoring
        ? '故事恢复指针保存失败，请保留原生恢复身份并重新查找原请求，不能重新创建。'
        : '故事恢复指针保存失败，未开始服务器生成。' });
      return false;
    }
  }

  /** Fresh public prewrite only. Caller must first verify Native has no existing claim. */
  prepare(value: DesktopArenaHostedStoryRecoveryPointer): boolean {
    return this.writeEmpty(value, false);
  }

  /**
   * Caller validates the Native snapshot/claim and constructs this public projection.
   * Reconstructed pointers enter explicit restore, never prepare/create, even before POST.
   */
  recoverFromClaim(value: DesktopArenaHostedStoryRecoveryPointer): boolean {
    return this.writeEmpty(value, true);
  }

  /** Exact live request only; a failed write retains the newest public state in memory. */
  update(requestId: string, patch: ArenaHostedStoryRecoveryPatch): boolean {
    const current = this.state.pointer;
    if (this.state.blocked || this.state.kind !== 'story' || !current || current.requestId !== requestId) return false;
    let pointer: DesktopArenaHostedStoryRecoveryPointer;
    try {
      if (Object.keys(patch).some((key) => !patchKeys.has(key))
        || (current.generationId !== undefined && 'generationId' in patch && patch.generationId !== current.generationId)
        || (patch.state === 'prepared' && current.state !== 'prepared')) throw new Error('invalid pointer patch');
      pointer = this.validate({ ...current, ...patch });
    } catch {
      this.publish({ saved: false, error: '故事恢复状态不符合协议，保留上一次有效身份与已收到正文。' });
      return false;
    }
    if (!this.originalIsCurrent()) {
      this.publish({ pointer });
      return false;
    }
    try {
      const raw = JSON.stringify(pointer);
      this.storage.setItem(this.key, raw);
      this.publish({ pointer, raw, saved: true, error: null });
      return true;
    } catch {
      this.publish({ pointer, saved: false,
        error: '最新故事恢复状态保存失败，当前身份与正文仍在内存；请完整导出，勿重新创建。' });
      return false;
    }
  }

  /** UI acknowledgement only. Native still verifies the original actor and exact claim. */
  acceptRestore(requestId: string): DesktopArenaHostedStoryRecoveryPointer | null {
    if (this.state.blocked || this.state.kind !== 'story' || this.state.pointer?.requestId !== requestId) return null;
    if (!this.originalIsCurrent()) return null;
    this.publish({ pendingRestore: false });
    return structuredClone(this.state.pointer);
  }

  /** Caller proves safe completion/abandonment first; this only removes its exact public original. */
  clear(requestId: string, expectedRaw: string): boolean {
    if (this.state.blocked || this.state.kind !== 'story' || this.state.pointer?.requestId !== requestId
      || this.state.raw !== expectedRaw) return false;
    if (!this.originalIsCurrent()) return false;
    try {
      this.storage.removeItem(this.key);
      this.publish(empty());
      return true;
    } catch {
      this.publish({ saved: false, error: '故事恢复指针清除失败，原数据仍受保护。' });
      return false;
    }
  }
}
