/** Web 身份失效信号。原始凭据只参与闭包比较，不进入快照、日志或业务协议。 */
export const AUTH_STORAGE_KEY = 'mahoshojo_auth';
const AUTH_CHANGE_KEY = 'mahoshojo_auth_change';

type StoredIdentity = Readonly<{ readable: boolean; auth: string | null; change: string | null }>;
export type AuthIdentity = Readonly<{ epoch: number; isCurrent(): boolean }>;
export type AuthIdentityEvent = Readonly<{
  identity: AuthIdentity;
  reason: 'external' | 'intent' | 'owned' | 'unavailable';
  revalidate?: boolean;
}>;
/** 每次认证操作独立拥有；不得交给 Room 或其他长生命周期消费者续签。 */
export type AuthIdentityOwner = { identity: AuthIdentity; settlesSnapshot?: boolean; failure?: AuthStorageError };

const readStorage = (): StoredIdentity => {
  try {
    return {
      readable: true,
      auth: localStorage.getItem(AUTH_STORAGE_KEY),
      change: localStorage.getItem(AUTH_CHANGE_KEY),
    };
  } catch {
    return { readable: false, auth: null, change: null };
  }
};
const sameStoredIdentity = (left: StoredIdentity, right: StoredIdentity) => (
  left.readable === right.readable && left.auth === right.auth && left.change === right.change
);
let epoch = 0;
let observed = readStorage();
const listeners = new Set<(_event: AuthIdentityEvent) => void>();
let monitoredWindow: Window | null = null;
const createIdentity = (stored: StoredIdentity): AuthIdentity => {
  const capturedEpoch = epoch;
  return Object.freeze({
    epoch: capturedEpoch,
    isCurrent: () => stored.readable && capturedEpoch === epoch && sameStoredIdentity(stored, readStorage()),
  });
};
let identity = createIdentity(observed);
const advance = (stored: StoredIdentity, reason: AuthIdentityEvent['reason'], owner?: AuthIdentityOwner) => {
  observed = stored;
  epoch += 1;
  identity = createIdentity(stored);
  if (owner) owner.identity = identity;
  for (const listener of listeners) listener({ identity, reason, revalidate: reason === 'owned' && !owner?.settlesSnapshot });
  return identity;
};
const observeStorage = () => {
  const stored = readStorage();
  if (!sameStoredIdentity(observed, stored)) advance(stored, stored.readable ? 'external' : 'unavailable');
};
const onStorage = (event: StorageEvent) => {
  if (event.key !== null && event.key !== AUTH_STORAGE_KEY && event.key !== AUTH_CHANGE_KEY) return;
  try {
    if (event.storageArea && event.storageArea !== localStorage) return;
  } catch {
    advance(readStorage(), 'unavailable');
    return;
  }
  // 事件本身也是一次换代证据：即使 A→null→原 A 已恢复相同字节，旧票据也不能复活。
  const stored = readStorage();
  advance(stored, stored.readable ? 'external' : 'unavailable');
};
const ensureMonitoring = () => {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function' || monitoredWindow === window) return;
  monitoredWindow?.removeEventListener('storage', onStorage);
  monitoredWindow?.removeEventListener('focus', observeStorage);
  monitoredWindow = window;
  window.addEventListener('storage', onStorage);
  window.addEventListener('focus', observeStorage);
};

export const getAuthIdentitySnapshot = (): AuthIdentity => identity;
export const captureAuthIdentity = (): AuthIdentity => {
  ensureMonitoring();
  observeStorage();
  return identity;
};
export const subscribeAuthIdentity = (listener: (_event: AuthIdentityEvent) => void): (() => void) => {
  ensureMonitoring();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const beginAuthIdentityTransition = (): AuthIdentityOwner => {
  ensureMonitoring();
  // 尚未完成的登录不能令别页提前用旧 cookie 校验；此处只撤销本页。
  const stored = readStorage();
  const owner: AuthIdentityOwner = { identity: advance(stored, stored.readable ? 'intent' : 'unavailable') };
  if (!stored.readable) owner.failure = new AuthStorageError();
  return owner;
};
/** 只描述本机存储失败；不推断服务端登录/退出是否已生效。 */
export class AuthStorageError extends Error {
  readonly isCurrent: () => boolean;
  constructor() {
    super('本机登录信息更新失败，请检查浏览器存储设置后重试');
    this.name = 'AuthStorageError';
    const failureIdentity = identity;
    const stored = readStorage();
    this.isCurrent = () => identity === failureIdentity && sameStoredIdentity(stored, readStorage());
  }
}

/** 认证操作的有副作用边界；普通消费者只能使用 immutable guard 的纯检查。 */
export const checkAuthIdentityOwner = (owner: AuthIdentityOwner): boolean => {
  if (owner.failure?.isCurrent()) throw owner.failure;
  // 已被取代的操作不能将当前账号的 IO 异常归给自己，也不能续签。
  if (owner.identity !== identity) return false;
  const stored = readStorage();
  if (!stored.readable) {
    advance(stored, 'unavailable');
    owner.failure = new AuthStorageError();
    throw owner.failure;
  }
  if (!sameStoredIdentity(observed, stored)) {
    advance(stored, 'external');
    return false;
  }
  return true;
};

export const commitAuthIdentity = (owner: AuthIdentityOwner, expectedAuth: string | null): boolean => {
  if (!checkAuthIdentityOwner(owner)) return false;
  let stored: StoredIdentity;
  let change: string;
  try {
    change = crypto.randomUUID();
    if (expectedAuth === null) localStorage.removeItem(AUTH_STORAGE_KEY);
    else localStorage.setItem(AUTH_STORAGE_KEY, expectedAuth);
    // 完成后的无秘密通知同时覆盖 auth 原值为 null 的 cookie-only 登录/退出。
    localStorage.setItem(AUTH_CHANGE_KEY, change);
    stored = readStorage();
    if (!stored.readable) throw new Error('storage unavailable');
  } catch {
    advance({ readable: false, auth: null, change: null }, 'unavailable');
    const failure = new AuthStorageError();
    owner.failure = failure;
    throw failure;
  }
  // localStorage 的两个写入不是事务：不能把另一标签页的提交续签给本操作。
  if (stored.auth !== expectedAuth || stored.change !== change) {
    advance(stored, 'external');
    return false;
  }
  advance(stored, 'owned', owner);
  return true;
};
