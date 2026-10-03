import test from 'node:test';
import assert from 'node:assert';
import { getDatabase, resetDatabase } from '../src/db/database.js';
import { DropService } from '../src/services/dropService.js';
import { PaymentService } from '../src/services/paymentService.js';

test('User Limits: Rule 2 (Max 1 active hold, max 2 purchases per user)', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);
  const paymentService = new PaymentService(db, dropService);
  const user = 'sneaker_fanatic_1';

  // 1. Acquire first hold
  const hold1 = dropService.requestHold(user, 'drop-1', 300);
  assert.strictEqual(hold1.success, true);

  // 2. Attempt to acquire a second active hold simultaneously -> Must be rejected!
  assert.throws(
    () => {
      dropService.requestHold(user, 'drop-1', 300);
    },
    /ACTIVE_HOLD_EXISTS/,
    'User cannot hold more than 1 pair at a time'
  );

  // 3. Complete payment for pair 1
  const pay1 = paymentService.processPaymentWebhook({
    holdId: hold1.holdId,
    userId: user,
  });
  assert.strictEqual(pay1.status, 'SUCCESS');

  // 4. Now that active hold is converted to purchase, user can acquire 2nd hold
  const hold2 = dropService.requestHold(user, 'drop-1', 300);
  assert.strictEqual(hold2.success, true);

  // 5. Complete payment for pair 2
  const pay2 = paymentService.processPaymentWebhook({
    holdId: hold2.holdId,
    userId: user,
  });
  assert.strictEqual(pay2.status, 'SUCCESS');

  // 6. User has now bought 2 pairs (the maximum limit). Attempting to hold a 3rd pair must fail!
  assert.throws(
    () => {
      dropService.requestHold(user, 'drop-1', 300);
    },
    /LIMIT_EXCEEDED/,
    'User cannot buy more than 2 pairs in total'
  );

  // Also verify user cannot join waitlist once limit of 2 is reached
  assert.throws(
    () => {
      dropService.joinWaitlist(user, 'drop-1');
    },
    /LIMIT_EXCEEDED/,
    'User cannot join waitlist when maximum limit reached'
  );
});
