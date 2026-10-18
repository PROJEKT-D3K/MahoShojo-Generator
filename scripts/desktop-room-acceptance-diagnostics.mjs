// Private stderr is never forwarded. Only this fixed vocabulary can reach CI.
const stages = new Set(['spawn', 'validate-args', 'load-fixture', 'listen', 'self-check', 'ready-output', 'control', 'cleanup', 'unknown']);
const codes = new Set([
  'UNKNOWN', 'INVALID_JSON', 'ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'EADDRINUSE',
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'CERT_HAS_EXPIRED',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'ERR_OSSL_PEM_NO_START_LINE', 'ERR_OSSL_X509_KEY_VALUES_MISMATCH',
  'ACCEPTANCE_ARGUMENT_INVALID', 'ACCEPTANCE_PORT_INVALID', 'ACCEPTANCE_BIND_FAILED',
  'ACCEPTANCE_SELFCHECK_NOT_PRISTINE', 'ACCEPTANCE_SELFCHECK_FAILED', 'ACCEPTANCE_SELFCHECK_WS',
  'ACCEPTANCE_PROBE_BOUND', 'ACCEPTANCE_PROBE_FAILED', 'ACCEPTANCE_PROBE_TIMEOUT', 'ACCEPTANCE_OUTPUT_BOUND',
]);
const prefix = 'ROOM_ACCEPTANCE_FAILURE';
const lineLimit = 256;

export function roomMockFailureCode(error) {
  // Never coerce an error, inspect its cause, or evaluate a custom getter.
  try {
    if (error && typeof error === 'object') {
      for (const key of ['code', 'message']) {
        const value = Object.getOwnPropertyDescriptor(error, key)?.value;
        if (typeof value === 'string' && codes.has(value)) return value;
      }
      if (error instanceof SyntaxError) return 'INVALID_JSON';
    }
  } catch { /* Unknown objects remain opaque. */ }
  return 'UNKNOWN';
}

export function formatRoomMockDiagnostic(stage, error) {
  return `${prefix} stage=${stages.has(stage) ? stage : 'unknown'} code=${roomMockFailureCode(error)}\n`;
}

export function createRoomMockDiagnostics() {
  let pending = Buffer.alloc(0), dropping = false, unrecognized = false, truncated = false, diagnostic;
  const consume = () => {
    const match = /^ROOM_ACCEPTANCE_FAILURE stage=([a-z-]+) code=([A-Z0-9_]+)$/.exec(pending.toString('utf8'));
    if (match && stages.has(match[1]) && codes.has(match[2])) diagnostic ??= { stage: match[1], code: match[2] };
    else unrecognized = true;
    pending = Buffer.alloc(0);
  };
  return {
    append(chunk) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      let start = 0;
      while (start < bytes.length) {
        const end = bytes.indexOf(10, start), stop = end === -1 ? bytes.length : end;
        if (!dropping) {
          if (pending.length + stop - start > lineLimit) {
            pending = Buffer.alloc(0); dropping = true; truncated = true;
          } else pending = Buffer.concat([pending, bytes.subarray(start, stop)]);
        }
        if (end === -1) break;
        if (!dropping) consume();
        dropping = false; start = end + 1;
      }
    },
    summary() {
      return (diagnostic ? `; stage=${diagnostic.stage}, reason=${diagnostic.code}` : '')
        + (unrecognized || pending.length ? '; stderr=unrecognized' : '')
        + (truncated ? '; stderr=truncated' : '');
    },
  };
}
