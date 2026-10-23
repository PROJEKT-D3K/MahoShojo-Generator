import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  LocalAiLaunchRuntimeRequestSchema, LocalAiLaunchRequestSchema,
  LocalAiLaunchOperationRequestSchema, LocalAiLaunchSnapshotSchema,
} from '../src/local-ai-launch';
const fixture = JSON.parse(readFileSync(new URL('../../../fixtures/local-ai-launch.json', import.meta.url), 'utf8'));
describe('local launch strict Native/TS contract', () => {
  for (const [valid, invalid, schema] of [
    ['runtimeRequests', 'invalidRuntimeRequests', LocalAiLaunchRuntimeRequestSchema],
    ['startRequests', 'invalidStartRequests', LocalAiLaunchRequestSchema],
    ['operationRequests', 'invalidOperationRequests', LocalAiLaunchOperationRequestSchema],
    ['snapshots', 'invalidSnapshots', LocalAiLaunchSnapshotSchema],
  ] as const) {
    it(`round trips ${valid} and rejects ${invalid}`, () => {
      for (const value of fixture[valid]) expect(schema.parse(value)).toEqual(value);
      for (const value of fixture[invalid]) expect(schema.safeParse(value).success).toBe(false);
    });
  }
  it('requires installation/service/error exactly for the corresponding state', () => {
    for (const snapshot of fixture.snapshots) {
      for (const field of ['operationId', 'installation', 'service', 'errorCode']) {
        const value = { ...snapshot }; delete value[field];
        if ((field === 'operationId' && snapshot.state !== 'idle') ||
          (field === 'installation' && ['prepared', 'starting', 'ready'].includes(snapshot.state)) ||
          (field === 'service' && ['ready', 'external'].includes(snapshot.state)) ||
          (field === 'errorCode' && snapshot.state === 'failed')) {
          expect(LocalAiLaunchSnapshotSchema.safeParse(value).success).toBe(false);
        }
      }
    }
  });
});
