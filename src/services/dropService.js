import crypto from 'node:crypto';

export class DropService {
  constructor(db) {
    this.db = db;
  }

  logAudit(eventType, userId, details) {
    try {
      this.db.prepare(`
        INSERT INTO audit_log (event_type, user_id, details, created_at)
        VALUES (?, ?, ?, ?)
      `).run(eventType, userId, typeof details === 'string' ? details : JSON.stringify(details), Date.now());
    } catch (err) {
      console.error('Audit log error:', err);
    }
  }

  getAuditLogs(limit = 25) {
    return this.db.prepare(`
      SELECT id, event_type, user_id, details, created_at
      FROM audit_log
      ORDER BY id DESC
      LIMIT ?
    `).all(limit);
  }

  getStatus(userId = 'guest', itemId = 'drop-1') {
    const item = this.db.prepare(`
      SELECT id, name, total_stock, available_stock, held_stock, sold_stock
      FROM inventory
      WHERE id = ?
    `).get(itemId);

    if (!item) {
      throw new Error(`Item ${itemId} not found in inventory`);
    }

    const now = Date.now();

    // Check user's active hold
    const activeHold = this.db.prepare(`
      SELECT id, user_id, item_id, status, created_at, expires_at
      FROM holds
      WHERE user_id = ? AND item_id = ? AND status = 'ACTIVE' AND expires_at > ?
    `).get(userId, itemId, now);

    let holdData = null;
    if (activeHold) {
      const remainingSeconds = Math.max(0, Math.ceil((activeHold.expires_at - now) / 1000));
      holdData = {
        holdId: activeHold.id,
        status: activeHold.status,
        expiresAt: activeHold.expires_at,
        remainingSeconds,
      };
    }

    // Check user's waitlist status
    const waitlistEntry = this.db.prepare(`
      SELECT id, status, joined_at
      FROM waitlist
      WHERE user_id = ? AND item_id = ? AND status = 'WAITING'
    `).get(userId, itemId);

    let waitlistData = null;
    if (waitlistEntry) {
      const posResult = this.db.prepare(`
        SELECT COUNT(*) as position
        FROM waitlist
        WHERE item_id = ? AND status = 'WAITING' AND (joined_at < ? OR (joined_at = ? AND id <= ?))
      `).get(itemId, waitlistEntry.joined_at, waitlistEntry.joined_at, waitlistEntry.id);

      const totalWaiting = this.db.prepare(`
        SELECT COUNT(*) as total
        FROM waitlist
        WHERE item_id = ? AND status = 'WAITING'
      `).get(itemId);

      waitlistData = {
        waitlistId: waitlistEntry.id,
        position: posResult.position,
        totalWaiting: totalWaiting.total,
        joinedAt: waitlistEntry.joined_at,
      };
    } else {
      const totalWaiting = this.db.prepare(`
        SELECT COUNT(*) as total
        FROM waitlist
        WHERE item_id = ? AND status = 'WAITING'
      `).get(itemId);
      waitlistData = {
        position: null,
        totalWaiting: totalWaiting.total,
      };
    }

    // Check total user purchases
    const userPurchases = this.db.prepare(`
      SELECT COUNT(*) as count
      FROM purchases
      WHERE user_id = ? AND item_id = ?
    `).get(userId, itemId);

    return {
      item,
      inventory: {
        total: item.total_stock,
        available: item.available_stock,
        held: item.held_stock,
        sold: item.sold_stock,
      },
      user: {
        userId,
        purchasedCount: userPurchases.count,
        maxAllowedPurchases: 2,
        canHoldOrBuy: userPurchases.count < 2 && !holdData,
        canJoinWaitlist: userPurchases.count < 2 && !holdData && !waitlistEntry && item.available_stock === 0,
        activeHold: holdData,
        waitlist: waitlistData,
      },
      serverTime: now,
    };
  }

  requestHold(userId, itemId = 'drop-1', ttlSeconds = 300) {
    if (!userId) {
      throw new Error('User ID is required');
    }

    const now = Date.now();
    const expiresAt = now + ttlSeconds * 1000;
    const holdId = `hold_${crypto.randomUUID()}`;

    // Execute within SQLite transaction for atomic reservation
    // node:sqlite transactions are executed synchronously
    this.db.exec('BEGIN IMMEDIATE;');

    try {
      // Rule 2: Max 2 pairs bought in total
      const purchaseCountRow = this.db.prepare(`
        SELECT COUNT(*) as count FROM purchases WHERE user_id = ? AND item_id = ?
      `).get(userId, itemId);

      if (purchaseCountRow.count >= 2) {
        throw new Error('LIMIT_EXCEEDED: You have already purchased the maximum of 2 pairs.');
      }

      // Rule 2: Hold only 1 pair at a time
      const activeHoldRow = this.db.prepare(`
        SELECT id FROM holds
        WHERE user_id = ? AND item_id = ? AND status = 'ACTIVE' AND expires_at > ?
      `).get(userId, itemId, now);

      if (activeHoldRow) {
        throw new Error('ACTIVE_HOLD_EXISTS: You already have an active hold for this sneaker.');
      }

      // Check inventory available stock
      const inventoryRow = this.db.prepare(`
        SELECT available_stock, held_stock, total_stock FROM inventory WHERE id = ?
      `).get(itemId);

      if (!inventoryRow || inventoryRow.available_stock <= 0) {
        this.db.exec('COMMIT;');
        return {
          success: false,
          reason: 'OUT_OF_STOCK',
          message: 'Sneakers are currently sold out or reserved. You can join the waiting line!',
        };
      }

      // Decrement available_stock and increment held_stock atomically
      const updateResult = this.db.prepare(`
        UPDATE inventory
        SET available_stock = available_stock - 1,
            held_stock = held_stock + 1
        WHERE id = ? AND available_stock > 0
      `).run(itemId);

      if (updateResult.changes === 0) {
        // Race condition handled: another transaction grabbed the last sneaker
        this.db.exec('COMMIT;');
        return {
          success: false,
          reason: 'OUT_OF_STOCK',
          message: 'The last pair was just claimed! You can join the waiting line.',
        };
      }

      // Insert hold record
      this.db.prepare(`
        INSERT INTO holds (id, user_id, item_id, status, created_at, expires_at, updated_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
      `).run(holdId, userId, itemId, now, expiresAt, now);

      // If user was in waitlist, mark it cancelled or fulfilled
      this.db.prepare(`
        UPDATE waitlist
        SET status = 'PROMOTED', promoted_at = ?
        WHERE user_id = ? AND item_id = ? AND status = 'WAITING'
      `).run(now, userId, itemId);

      this.db.exec('COMMIT;');

      this.logAudit('HOLD_ACQUIRED', userId, { holdId, itemId, expiresAt, ttlSeconds });

      return {
        success: true,
        holdId,
        userId,
        expiresAt,
        ttlSeconds,
        remainingSeconds: ttlSeconds,
        message: 'Pair held for 5 minutes! Complete payment before countdown expires.',
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  joinWaitlist(userId, itemId = 'drop-1') {
    if (!userId) {
      throw new Error('User ID is required');
    }

    const now = Date.now();
    const waitlistId = `wait_${crypto.randomUUID()}`;

    this.db.exec('BEGIN IMMEDIATE;');

    try {
      // Check purchase limits
      const purchaseCountRow = this.db.prepare(`
        SELECT COUNT(*) as count FROM purchases WHERE user_id = ? AND item_id = ?
      `).get(userId, itemId);

      if (purchaseCountRow.count >= 2) {
        throw new Error('LIMIT_EXCEEDED: You have already purchased the maximum of 2 pairs.');
      }

      // Check active hold
      const activeHold = this.db.prepare(`
        SELECT id FROM holds
        WHERE user_id = ? AND item_id = ? AND status = 'ACTIVE' AND expires_at > ?
      `).get(userId, itemId, now);

      if (activeHold) {
        throw new Error('ACTIVE_HOLD_EXISTS: You already have an active hold.');
      }

      // Check if already in waitlist
      const existingWaitlist = this.db.prepare(`
        SELECT id, joined_at FROM waitlist
        WHERE user_id = ? AND item_id = ? AND status = 'WAITING'
      `).get(userId, itemId);

      if (existingWaitlist) {
        const posResult = this.db.prepare(`
          SELECT COUNT(*) as position FROM waitlist
          WHERE item_id = ? AND status = 'WAITING' AND joined_at <= ?
        `).get(itemId, existingWaitlist.joined_at);

        this.db.exec('COMMIT;');
        return {
          success: true,
          waitlistId: existingWaitlist.id,
          position: posResult.position,
          message: 'You are already in the waiting line.',
        };
      }

      // Check inventory: waitlist only opens when available_stock is 0
      const inventory = this.db.prepare(`
        SELECT available_stock FROM inventory WHERE id = ?
      `).get(itemId);

      if (inventory && inventory.available_stock > 0) {
        this.db.exec('COMMIT;');
        return {
          success: false,
          reason: 'STOCK_AVAILABLE',
          message: 'Stock is currently available! Click Buy directly.',
        };
      }

      // Insert into waitlist
      this.db.prepare(`
        INSERT INTO waitlist (id, user_id, item_id, status, joined_at)
        VALUES (?, ?, ?, 'WAITING', ?)
      `).run(waitlistId, userId, itemId, now);

      const posResult = this.db.prepare(`
        SELECT COUNT(*) as position FROM waitlist
        WHERE item_id = ? AND status = 'WAITING' AND joined_at <= ?
      `).get(itemId, now);

      this.db.exec('COMMIT;');

      this.logAudit('WAITLIST_JOINED', userId, { waitlistId, position: posResult.position });

      return {
        success: true,
        waitlistId,
        position: posResult.position,
        message: `Joined waiting line at position #${posResult.position}. You will automatically get a pair if a hold expires!`,
      };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  cancelHold(userId, holdId, itemId = 'drop-1') {
    const now = Date.now();
    this.db.exec('BEGIN IMMEDIATE;');

    try {
      const hold = this.db.prepare(`
        SELECT * FROM holds WHERE id = ? AND user_id = ? AND status = 'ACTIVE'
      `).get(holdId, userId);

      if (!hold) {
        throw new Error('Hold not found or not active');
      }

      // Mark hold cancelled
      this.db.prepare(`
        UPDATE holds SET status = 'CANCELLED', updated_at = ? WHERE id = ?
      `).run(now, holdId);

      // Check waitlist for promotion
      const promoted = this.promoteNextInWaitlist(itemId, now);

      if (!promoted) {
        // Return 1 pair back to available stock
        this.db.prepare(`
          UPDATE inventory
          SET held_stock = held_stock - 1, available_stock = available_stock + 1
          WHERE id = ?
        `).run(itemId);
      }

      this.db.exec('COMMIT;');

      this.logAudit('HOLD_CANCELLED', userId, { holdId, promotedUserId: promoted ? promoted.userId : null });

      return { success: true, message: 'Hold cancelled successfully' };
    } catch (err) {
      this.db.exec('ROLLBACK;');
      throw err;
    }
  }

  expireHolds(itemId = 'drop-1', defaultTtlSeconds = 300) {
    const now = Date.now();

    // Query for any expired active holds
    const expiredHolds = this.db.prepare(`
      SELECT id, user_id, item_id
      FROM holds
      WHERE item_id = ? AND status = 'ACTIVE' AND expires_at <= ?
    `).all(itemId, now);

    if (expiredHolds.length === 0) {
      return 0;
    }

    let processedCount = 0;

    for (const hold of expiredHolds) {
      this.db.exec('BEGIN IMMEDIATE;');
      try {
        // Atomic compare-and-swap
        const updateResult = this.db.prepare(`
          UPDATE holds
          SET status = 'EXPIRED', updated_at = ?
          WHERE id = ? AND status = 'ACTIVE'
        `).run(now, hold.id);

        if (updateResult.changes === 0) {
          // Already changed by a payment webhook arriving simultaneously
          this.db.exec('COMMIT;');
          continue;
        }

        this.logAudit('HOLD_EXPIRED', hold.user_id, { holdId: hold.id });

        // Rule 3: Promote next person in line automatically
        const promoted = this.promoteNextInWaitlist(itemId, now, defaultTtlSeconds);

        if (!promoted) {
          // No one in line; return to available stock
          this.db.prepare(`
            UPDATE inventory
            SET held_stock = held_stock - 1,
                available_stock = available_stock + 1
            WHERE id = ?
          `).run(itemId);
          this.logAudit('STOCK_RETURNED', null, { itemId, reason: 'Hold expired with empty waitlist' });
        }

        this.db.exec('COMMIT;');
        processedCount++;
      } catch (err) {
        this.db.exec('ROLLBACK;');
        console.error('Error expiring hold:', hold.id, err);
      }
    }

    return processedCount;
  }

  // Internal helper called inside an active transaction
  promoteNextInWaitlist(itemId, now, ttlSeconds = 300) {
    // Find earliest waiting user who is still eligible (under max 2 purchases)
    const waitingUsers = this.db.prepare(`
      SELECT id, user_id, joined_at
      FROM waitlist
      WHERE item_id = ? AND status = 'WAITING'
      ORDER BY joined_at ASC
    `).all(itemId);

    for (const candidate of waitingUsers) {
      const purchases = this.db.prepare(`
        SELECT COUNT(*) as count FROM purchases WHERE user_id = ? AND item_id = ?
      `).get(candidate.user_id, itemId);

      if (purchases.count >= 2) {
        // Ineligible, mark cancelled
        this.db.prepare(`
          UPDATE waitlist SET status = 'CANCELLED' WHERE id = ?
        `).run(candidate.id);
        continue;
      }

      // Check if user already got another active hold
      const existingHold = this.db.prepare(`
        SELECT id FROM holds
        WHERE user_id = ? AND item_id = ? AND status = 'ACTIVE' AND expires_at > ?
      `).get(candidate.user_id, itemId, now);

      if (existingHold) {
        this.db.prepare(`
          UPDATE waitlist SET status = 'CANCELLED' WHERE id = ?
        `).run(candidate.id);
        continue;
      }

      // Eligible candidate found!
      this.db.prepare(`
        UPDATE waitlist SET status = 'PROMOTED', promoted_at = ? WHERE id = ?
      `).run(now, candidate.id);

      const newHoldId = `hold_${crypto.randomUUID()}`;
      const expiresAt = now + ttlSeconds * 1000;

      this.db.prepare(`
        INSERT INTO holds (id, user_id, item_id, status, created_at, expires_at, updated_at)
        VALUES (?, ?, ?, 'ACTIVE', ?, ?, ?)
      `).run(newHoldId, candidate.user_id, itemId, now, expiresAt, now);

      this.logAudit('WAITLIST_PROMOTED', candidate.user_id, {
        waitlistId: candidate.id,
        newHoldId,
        expiresAt,
        ttlSeconds,
      });

      return {
        userId: candidate.user_id,
        holdId: newHoldId,
        expiresAt,
      };
    }

    return null;
  }
}
