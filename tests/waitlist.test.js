import test from 'node:test';
import assert from 'node:assert';
import { getDatabase, resetDatabase } from '../src/db/database.js';
import { DropService } from '../src/services/dropService.js';

test('Waitlist: Rule 3 (FIFO waitlist promotion when hold expires)', async () => {
  const db = getDatabase(':memory:');
  // Seed with only 1 pair to test waitlist transition cleanly
  resetDatabase(db, 1);

  const dropService = new DropService(db);

  // 1. User A acquires the only pair
  const holdA = dropService.requestHold('user_A', 'drop-1', 300);
  assert.strictEqual(holdA.success, true);

  // Stock is now 0 available!
  const status1 = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status1.inventory.available, 0);

  // 2. User B tries to buy -> gets OUT_OF_STOCK
  const buyB = dropService.requestHold('user_B', 'drop-1', 300);
  assert.strictEqual(buyB.success, false);
  assert.strictEqual(buyB.reason, 'OUT_OF_STOCK');

  // 3. User B joins waitlist (should be #1)
  const waitB = dropService.joinWaitlist('user_B', 'drop-1');
  assert.strictEqual(waitB.success, true);
  assert.strictEqual(waitB.position, 1);

  // 4. User C also joins waitlist (should be #2)
  const waitC = dropService.joinWaitlist('user_C', 'drop-1');
  assert.strictEqual(waitC.success, true);
  assert.strictEqual(waitC.position, 2);

  // 5. User A fails to pay within 5 minutes -> Hold expires!
  db.prepare(`UPDATE holds SET expires_at = ? WHERE id = ?`).run(Date.now() - 1000, holdA.holdId);

  // Cleanup worker ticks and processes hold expiration
  const expiredCount = dropService.expireHolds('drop-1', 300);
  assert.strictEqual(expiredCount, 1);

  // 6. User B should have been automatically PROMOTED!
  const statusB = dropService.getStatus('user_B', 'drop-1');
  assert.ok(statusB.user.activeHold, 'User B should now possess an active hold');
  assert.strictEqual(statusB.user.activeHold.status, 'ACTIVE');
  assert.strictEqual(statusB.user.waitlist.position, null, 'User B should no longer be waiting');

  // 7. User C should now be #1 in line!
  const statusC = dropService.getStatus('user_C', 'drop-1');
  assert.strictEqual(statusC.user.waitlist.position, 1, 'User C should have moved up to #1');

  // 8. Available stock is still 0 because the pair transferred directly to User B!
  assert.strictEqual(statusB.inventory.available, 0);
  assert.strictEqual(statusB.inventory.held, 1);
});
