import crypto from 'node:crypto';

export class PaymentService {
  constructor(db, dropService) {
    this.db = db;
    this.dropService = dropService;
  }

  processPaymentWebhook({
    idempotencyKey = `evt_${crypto.randomUUID()}`,
    holdId,
    userId,
    amount = 150,
    status = 'SUCCESS',
  }) {
    if (!holdId) {
      return {
        status: 'REJECTED',
        reason: 'MISSING_HOLD_ID',
        message: 'Webhook missing required holdId parameter.',
      };
    }

    const now = Date.now();

    this.db.exec('BEGIN IMMEDIATE;');

    try {
      // 1. Idempotency Check: prevent duplicate processing of the exact same event
      const existingEvent = this.db.prepare(`
        SELECT idempotency_key, status, details FROM payment_events WHERE idempotency_key = ?
      `).get(idempotencyKey);

      if (existingEvent) {
        this.db.exec('COMMIT;');
        this.dropService.logAudit('PAYMENT_DUPLICATE_DROPPED', userId, {
          idempotencyKey,
          holdId,
          prevStatus: existingEvent.status,
        });
        return {
          status: 'DUPLICATE_ACKNOWLEDGED',
          idempotencyKey,
          message: 'Payment event already processed. Duplicate safely acknowledged without double charging.',
        };
      }

      // 2. Fetch Hold
      const hold = this.db.prepare(`
        SELECT id, user_id, item_id, status, expires_at
        FROM holds
        WHERE id = ?
      `).get(holdId);

      if (!hold) {
        this.db.prepare(`
          INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
          VALUES (?, ?, ?, 'REJECTED', ?, ?)
        `).run(idempotencyKey, holdId, userId || 'unknown', 'Hold not found in system', now);

        this.db.exec('COMMIT;');
        return {
          status: 'REJECTED',
          reason: 'HOLD_NOT_FOUND',
          message: `Hold with ID ${holdId} does not exist.`,
        };
      }

      // Verify user if provided
      if (userId && hold.user_id !== userId) {
        this.db.prepare(`
          INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
          VALUES (?, ?, ?, 'REJECTED', ?, ?)
        `).run(idempotencyKey, holdId, userId, 'User mismatch', now);

        this.db.exec('COMMIT;');
        return {
          status: 'REJECTED',
          reason: 'USER_MISMATCH',
          message: 'Hold does not belong to specified user.',
        };
      }

      // 3. Handle Already Paid (idempotency across different event keys for the same hold)
      if (hold.status === 'PAID') {
        this.db.prepare(`
          INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
          VALUES (?, ?, ?, 'DUPLICATE_IGNORED', ?, ?)
        `).run(idempotencyKey, holdId, hold.user_id, 'Hold already marked as PAID', now);

        this.db.exec('COMMIT;');
        return {
          status: 'ALREADY_PAID',
          holdId,
          message: 'This hold was already paid for. No duplicate charge or allocation applied.',
        };
      }

      // 4. Handle Late Payment (Hold already expired or cancelled)
      // Check if hold is expired either in DB status or timestamp
      const isExpired = hold.status === 'EXPIRED' || hold.status === 'CANCELLED' || (hold.status === 'ACTIVE' && hold.expires_at <= now);

      if (isExpired) {
        // If it was still marked ACTIVE in DB but past timestamp, mark it EXPIRED now
        if (hold.status === 'ACTIVE') {
          this.db.prepare(`
            UPDATE holds SET status = 'EXPIRED', updated_at = ? WHERE id = ?
          `).run(now, hold.id);
          // And promote waitlist or return stock
          const promoted = this.dropService.promoteNextInWaitlist(hold.item_id, now);
          if (!promoted) {
            this.db.prepare(`
              UPDATE inventory
              SET held_stock = held_stock - 1, available_stock = available_stock + 1
              WHERE id = ?
            `).run(hold.item_id);
          }
        }

        // Automatic refund handling for messy late delivery
        this.db.prepare(`
          INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
          VALUES (?, ?, ?, 'LATE_REFUNDED', ?, ?)
        `).run(idempotencyKey, holdId, hold.user_id, 'Payment arrived late after hold expired. Refund issued.', now);

        this.db.exec('COMMIT;');

        this.dropService.logAudit('PAYMENT_LATE_REFUNDED', hold.user_id, {
          holdId,
          idempotencyKey,
          reason: 'Hold expired before payment callback arrived',
        });

        return {
          status: 'LATE_REFUNDED',
          holdId,
          message: 'Hold expired before payment succeeded. Pair was released/promoted. Automatic refund issued!',
        };
      }

      // 5. Handle Payment Failure from Processor (e.g. Card Declined)
      if (status !== 'SUCCESS') {
        this.db.prepare(`
          UPDATE holds SET status = 'CANCELLED', updated_at = ? WHERE id = ? AND status = 'ACTIVE'
        `).run(now, hold.id);

        const promoted = this.dropService.promoteNextInWaitlist(hold.item_id, now);
        if (!promoted) {
          this.db.prepare(`
            UPDATE inventory
            SET held_stock = held_stock - 1, available_stock = available_stock + 1
            WHERE id = ?
          `).run(hold.item_id);
        }

        this.db.prepare(`
          INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
          VALUES (?, ?, ?, 'REJECTED', ?, ?)
        `).run(idempotencyKey, holdId, hold.user_id, 'Payment failed by processor. Hold released.', now);

        this.db.exec('COMMIT;');
        this.dropService.logAudit('PAYMENT_FAILED_RELEASED', hold.user_id, { holdId, idempotencyKey });

        return {
          status: 'PAYMENT_FAILED',
          holdId,
          message: 'Payment failed. Hold was cancelled and pair reassigned to waitlist or returned to stock.',
        };
      }

      // 5. Successful payment flow: Hold is ACTIVE and unexpired!
      const purchaseId = `pur_${crypto.randomUUID()}`;

      // Mark hold PAID
      this.db.prepare(`
        UPDATE holds
        SET status = 'PAID', updated_at = ?
        WHERE id = ? AND status = 'ACTIVE'
      `).run(now, hold.id);

      // Shift inventory: held_stock -> sold_stock
      this.db.prepare(`
        UPDATE inventory
        SET held_stock = held_stock - 1,
            sold_stock = sold_stock + 1
        WHERE id = ?
      `).run(hold.item_id);

      // Create purchase record
      this.db.prepare(`
        INSERT INTO purchases (id, user_id, item_id, hold_id, payment_event_id, amount, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(purchaseId, hold.user_id, hold.item_id, hold.id, idempotencyKey, amount, now);

      // Record successful payment event
      this.db.prepare(`
        INSERT INTO payment_events (idempotency_key, hold_id, user_id, status, details, created_at)
        VALUES (?, ?, ?, 'PROCESSED', ?, ?)
      `).run(idempotencyKey, holdId, hold.user_id, 'Payment processed successfully', now);

      this.db.exec('COMMIT;');

      this.dropService.logAudit('PAYMENT_SUCCESS', hold.user_id, {
        holdId,
        purchaseId,
        idempotencyKey,
        amount,
      });

      return {
        status: 'SUCCESS',
        purchaseId,
        holdId,
        userId: hold.user_id,
        amount,
        message: 'Payment received! Sneaker drop order confirmed.',
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  // Simulation harness for testing the 4 chaotic payment webhook conditions
  async simulatePayment({ holdId, userId, mode = 'immediate' }) {
    if (mode === 'duplicate') {
      // Send two identical webhooks to test idempotency handling.
      // Note: node:sqlite operations are synchronous and Node.js is single-threaded,
      // so these execute sequentially. The idempotency_key-based deduplication
      // is still correctly validated. In a production system with a network-based
      // database, Promise.all would create true concurrent execution.
      const idempotencyKey = `evt_dup_${crypto.randomUUID()}`;
      const [res1, res2] = await Promise.all([
        Promise.resolve(this.processPaymentWebhook({ idempotencyKey, holdId, userId })),
        Promise.resolve(this.processPaymentWebhook({ idempotencyKey, holdId, userId })),
      ]);
      return {
        mode: 'duplicate',
        firstCall: res1,
        secondCall: res2,
        idempotencyKey,
      };
    }

    if (mode === 'late') {
      // Force the hold to expire before firing the webhook
      this.db.prepare(`
        UPDATE holds SET expires_at = ? WHERE id = ?
      `).run(Date.now() - 1000, holdId);

      this.dropService.expireHolds();

      const result = this.processPaymentWebhook({
        idempotencyKey: `evt_late_${crypto.randomUUID()}`,
        holdId,
        userId,
      });

      return {
        mode: 'late',
        result,
      };
    }

    if (mode === 'delayed') {
      // Wait 3 seconds then deliver
      await new Promise((resolve) => setTimeout(resolve, 3000));
      return {
        mode: 'delayed',
        result: this.processPaymentWebhook({
          idempotencyKey: `evt_delayed_${crypto.randomUUID()}`,
          holdId,
          userId,
        }),
      };
    }

    // Default immediate
    return {
      mode: 'immediate',
      result: this.processPaymentWebhook({
        idempotencyKey: `evt_imm_${crypto.randomUUID()}`,
        holdId,
        userId,
      }),
    };
  }
}
