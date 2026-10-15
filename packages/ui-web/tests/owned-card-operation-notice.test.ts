import { expect, test } from 'vitest';
import { getOwnedCardDeleteNotice } from '../src/cloud-save/owned-card-delete';
import { getOwnedCardRestoreNotice } from '../src/cloud-save/owned-card-restore';
test('session notices isolate account, credential generation, operation and scope without reviving old warnings', () => {
  const scope = {};
  const notice = getOwnedCardDeleteNotice(scope, 1, 7); notice.uncertain = true;
  expect(getOwnedCardDeleteNotice(scope, 1, 7)).toBe(notice);
  expect(getOwnedCardRestoreNotice(scope, 1, 7).uncertain).toBe(false);
  expect(getOwnedCardDeleteNotice({}, 1, 7).uncertain).toBe(false);
  expect(getOwnedCardDeleteNotice(scope, 1, 8).uncertain).toBe(false);
  expect(getOwnedCardDeleteNotice(scope, 1, 7).uncertain).toBe(false);
  getOwnedCardDeleteNotice(scope, 1, 7).uncertain = true;
  expect(getOwnedCardDeleteNotice(scope, 2, 7).uncertain).toBe(false);
});
