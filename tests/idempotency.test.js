import test from 'node:test';
import assert from 'node:assert';
import { getDatabase, resetDatabase } from '../src/db/database.js';
import { DropService } from '../src/services/dropService.js';
import { PaymentService } from '../src/services/paymentService.js';

test('Payment Webhook Idempotency: Duplicate delivery handling', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);
  const paymentService = new PaymentService(db, dropService);

  const hold = dropService.requestHold('buyer_1', 'drop-1', 300);
  assert.strictEqual(hold.success, true);

  const idempotencyKey = 'evt_test_12345';

  // First webhook delivery
  const res1 = paymentService.processPaymentWebhook({
    idempotencyKey,
    holdId: hold.holdId,
    userId: 'buyer_1',
  });
  assert.strictEqual(res1.status, 'SUCCESS');

  // Second delivery with the SAME idempotency key (network retry / duplicate delivery)
  const res2 = paymentService.processPaymentWebhook({
    idempotencyKey,
    holdId: hold.holdId,
    userId: 'buyer_1',
  });
  assert.strictEqual(res2.status, 'DUPLICATE_ACKNOWLEDGED');

  // Third delivery for the same hold but different idempotency key
  const res3 = paymentService.processPaymentWebhook({
    idempotencyKey: 'evt_test_99999',
    holdId: hold.holdId,
    userId: 'buyer_1',
  });
  assert.strictEqual(res3.status, 'ALREADY_PAID');

  // Verify only 1 purchase row exists in DB
  const purchaseCount = db.prepare('SELECT COUNT(*) as count FROM purchases WHERE hold_id = ?').get(hold.holdId);
  assert.strictEqual(purchaseCount.count, 1, 'Only 1 purchase record created despite multiple webhooks');

  // Verify inventory: exactly 1 sold, 19 available, 0 held
  const status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.sold, 1);
  assert.strictEqual(status.inventory.held, 0);
  assert.strictEqual(status.inventory.available, 19);
});

test('Payment Webhook Chaos: Late payment arrives after hold expired', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);
  const paymentService = new PaymentService(db, dropService);

  // User holds a pair with a 1-second TTL
  const hold = dropService.requestHold('late_buyer', 'drop-1', 1);

  // Fast forward hold expiration
  db.prepare(`UPDATE holds SET expires_at = ? WHERE id = ?`).run(Date.now() - 5000, hold.holdId);

  // Background worker runs and marks it expired, returning stock
  const expiredCount = dropService.expireHolds('drop-1');
  assert.strictEqual(expiredCount, 1);

  // Available stock is restored back to 20
  const midStatus = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(midStatus.inventory.available, 20);

  // Now, the messy payment provider webhook finally arrives late!
  const lateWebhook = paymentService.processPaymentWebhook({
    idempotencyKey: 'evt_very_late',
    holdId: hold.holdId,
    userId: 'late_buyer',
  });

  // Must NOT oversell! Must issue automated refund!
  assert.strictEqual(lateWebhook.status, 'LATE_REFUNDED');

  // Stock must still be exactly 20 (not negative or deducted!)
  const finalStatus = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(finalStatus.inventory.available, 20);
  assert.strictEqual(finalStatus.inventory.sold, 0);
});

test('Payment Webhook Chaos: Failed payment cancels hold and releases inventory', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);
  const paymentService = new PaymentService(db, dropService);

  const hold = dropService.requestHold('declined_buyer', 'drop-1', 300);
  assert.strictEqual(hold.success, true);

  // Available stock is 19, held is 1
  let status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.available, 19);
  assert.strictEqual(status.inventory.held, 1);

  // Payment gateway returns FAILED
  const failRes = paymentService.processPaymentWebhook({
    idempotencyKey: 'evt_declined_1',
    holdId: hold.holdId,
    userId: 'declined_buyer',
    status: 'FAILED',
  });

  assert.strictEqual(failRes.status, 'PAYMENT_FAILED');

  // Inventory should be restored immediately back to 20
  status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.available, 20);
  assert.strictEqual(status.inventory.held, 0);
  assert.strictEqual(status.inventory.sold, 0);
});

