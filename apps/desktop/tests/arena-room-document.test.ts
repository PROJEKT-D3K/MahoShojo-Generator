import { webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const native = readFileSync(new URL('../src-tauri/src/arena_room_tauri.rs', import.meta.url), 'utf8');
const script = /const DOCUMENT_SCRIPT: &str = r#"([\s\S]*?)"#;/u.exec(native)?.[1];
if (!script) throw new Error('Missing native document initialization script');
const key = '__MAHOSHOJO_ROOM_DOCUMENT_V1__';
// Tauri append_invoke_initialization_script uses push_str, and ipc-protocol.js
// ends with an unterminated IIFE. Execute that boundary, including a later append.
const before = '(()=>{window.ipcInitialized=true})()';
const after = '(()=>{window.laterInitialized=true})()';
const frame = (main: boolean) => {
  const window: Record<string, unknown> = {};
  window.top = main ? window : {};
  return { window, context: createContext({ window, crypto: webcrypto }) };
};

describe('Room Document initialization at the actual append boundary', () => {
  it('executes consecutive initializers without calling the previous IIFE result', () => {
    const { window, context } = frame(true);
    runInContext(before + script + after, context);
    expect(window.ipcInitialized).toBe(true);
    expect(window.laterInitialized).toBe(true);
    expect(window[key]).toMatch(/^[0-9a-f]{64}$/u);
    expect(Object.getOwnPropertyDescriptor(window, key)).toMatchObject({
      writable: false, configurable: false, enumerable: false,
    });
  });

  it('preserves one immutable nonce per Document and uses fresh entropy for another', () => {
    const first = frame(true), second = frame(true);
    runInContext(before + script, first.context);
    const nonce = first.window[key];
    runInContext(script + after, first.context);
    expect(first.window[key]).toBe(nonce);
    expect(Reflect.set(first.window, key, 'replacement')).toBe(false);
    expect(Reflect.deleteProperty(first.window, key)).toBe(false);
    runInContext(before + script, second.context);
    expect(second.window[key]).toMatch(/^[0-9a-f]{64}$/u);
    expect(second.window[key]).not.toBe(nonce);
  });

  it('does not grant a nonce to subframes or stop later scripts there', () => {
    const { window, context } = frame(false);
    runInContext(before + script + after, context);
    expect(Object.hasOwn(window, key)).toBe(false);
    expect(window.ipcInitialized).toBe(true);
    expect(window.laterInitialized).toBe(true);
  });
});
