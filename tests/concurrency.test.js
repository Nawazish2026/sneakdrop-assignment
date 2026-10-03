import test from 'node:test';
import assert from 'node:assert';
import { getDatabase, resetDatabase } from '../src/db/database.js';
import { DropService } from '../src/services/dropService.js';

test('Concurrency Test: 100 simultaneous buyers competing for 20 pairs', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);
  const totalCompetitors = 100;

  // Launch 100 simultaneous promises
  const promises = Array.from({ length: totalCompetitors }, (_, i) => {
    const userId = `concurrent_buyer_${i + 1}`;
    return Promise.resolve().then(() => dropService.requestHold(userId, 'drop-1', 300));
  });

  const results = await Promise.all(promises);

  const successfulHolds = results.filter((r) => r.success);
  const outOfStock = results.filter((r) => !r.success && r.reason === 'OUT_OF_STOCK');

  // Strict Assertion: Exactly 20 holds granted
  assert.strictEqual(successfulHolds.length, 20, `Expected exactly 20 holds, got ${successfulHolds.length}`);
  // Remaining 80 got OUT_OF_STOCK
  assert.strictEqual(outOfStock.length, 80, `Expected 80 out of stock responses, got ${outOfStock.length}`);

  // Invariant verification in DB
  const status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.available, 0, 'Available stock should be 0');
  assert.strictEqual(status.inventory.held, 20, 'Held stock should be 20');
  assert.strictEqual(status.inventory.sold, 0, 'Sold stock should be 0');
  assert.strictEqual(
    status.inventory.available + status.inventory.held + status.inventory.sold,
    20,
    'Total inventory conservation invariant holds!'
  );
});

test('Historical 51-Buyer Incident: 51 buyers click simultaneously when stock is 20', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 20);

  const dropService = new DropService(db);

  // 51 simultaneous buyers hit Buy at the exact same millisecond
  const promises = Array.from({ length: 51 }, (_, i) => {
    const userId = `incident_buyer_${i + 1}`;
    return Promise.resolve().then(() => dropService.requestHold(userId, 'drop-1', 300));
  });

  const results = await Promise.all(promises);

  const successfulHolds = results.filter((r) => r.success);
  const outOfStock = results.filter((r) => !r.success && r.reason === 'OUT_OF_STOCK');

  // Exactly 20 holds granted (NO 51 SOLD BUG, 0 REFUNDS NEEDED!)
  assert.strictEqual(successfulHolds.length, 20, 'Only 20 holds granted');
  assert.strictEqual(outOfStock.length, 31, 'Exactly 31 diverted safely to out-of-stock / waitlist');

  const status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.held, 20);
  assert.strictEqual(status.inventory.available, 0);
  assert.strictEqual(status.inventory.sold, 0);
});

test('51-Pairs Drop: 150 simultaneous buyers competing for 51 pairs', async () => {
  const db = getDatabase(':memory:');
  resetDatabase(db, 51);

  const dropService = new DropService(db);
  const totalCompetitors = 150;

  const promises = Array.from({ length: totalCompetitors }, (_, i) => {
    const userId = `buyer_51_drop_${i + 1}`;
    return Promise.resolve().then(() => dropService.requestHold(userId, 'drop-1', 300));
  });

  const results = await Promise.all(promises);

  const successfulHolds = results.filter((r) => r.success);
  const outOfStock = results.filter((r) => !r.success && r.reason === 'OUT_OF_STOCK');

  assert.strictEqual(successfulHolds.length, 51, 'Exactly 51 holds granted');
  assert.strictEqual(outOfStock.length, 99, 'Remaining 99 safely rejected without overselling');

  const status = dropService.getStatus('admin', 'drop-1');
  assert.strictEqual(status.inventory.available, 0);
  assert.strictEqual(status.inventory.held, 51);
  assert.strictEqual(status.inventory.sold, 0);
  assert.strictEqual(
    status.inventory.available + status.inventory.held + status.inventory.sold,
    51,
    'Invariant strictly holds for 51 pairs!'
  );
});

