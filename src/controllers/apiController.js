import express from 'express';
import { resetDatabase } from '../db/database.js';

export function createApiController({ dropService, paymentService, cleanupWorker }) {
  const router = express.Router();
  const sseClients = new Set();

  function broadcastUpdate(event = 'update', data = {}) {
    for (const res of sseClients) {
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch (err) {
        sseClients.delete(res);
      }
    }
  }

  // Subscribe cleanup worker to broadcast whenever holds expire/promote
  cleanupWorker.addListener((evt) => {
    broadcastUpdate('inventory_changed', evt);
  });

  // Real-time Server-Sent Events (SSE)
  router.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    sseClients.add(res);
    res.write(`event: connected\ndata: ${JSON.stringify({ time: Date.now() })}\n\n`);

    const heartbeat = setInterval(() => {
      try {
        res.write(': keep-alive\n\n');
      } catch (err) {
        clearInterval(heartbeat);
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      sseClients.delete(res);
    });
  });

  // 1. Get Drop Status
  router.get('/status', (req, res) => {
    try {
      const userId = req.query.userId || 'user_1';
      const itemId = req.query.itemId || 'drop-1';
      const status = dropService.getStatus(userId, itemId);
      res.json(status);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 2. Request Hold (Rule 1 & Rule 2)
  router.post('/drop/hold', (req, res) => {
    try {
      const { userId, itemId = 'drop-1', ttlSeconds = 300 } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const result = dropService.requestHold(userId, itemId, Number(ttlSeconds));
      broadcastUpdate('inventory_changed', { type: 'HOLD_ACQUIRED', userId });
      res.json(result);
    } catch (err) {
      if (err.message.startsWith('LIMIT_EXCEEDED') || err.message.startsWith('ACTIVE_HOLD_EXISTS')) {
        return res.status(400).json({ error: err.message });
      }
      res.status(500).json({ error: err.message });
    }
  });

  // 3. Join Waitlist (Rule 3)
  router.post('/drop/waitlist', (req, res) => {
    try {
      const { userId, itemId = 'drop-1' } = req.body;
      if (!userId) {
        return res.status(400).json({ error: 'userId is required' });
      }

      const result = dropService.joinWaitlist(userId, itemId);
      broadcastUpdate('inventory_changed', { type: 'WAITLIST_UPDATED', userId });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 4. Cancel Active Hold
  router.post('/drop/cancel', (req, res) => {
    try {
      const { userId, holdId, itemId = 'drop-1' } = req.body;
      const result = dropService.cancelHold(userId, holdId, itemId);
      broadcastUpdate('inventory_changed', { type: 'HOLD_CANCELLED', userId });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // 5. Fake Payment Webhook (Rule 4)
  router.post('/payments/webhook', (req, res) => {
    try {
      const { idempotencyKey, holdId, userId, amount, status } = req.body;
      const result = paymentService.processPaymentWebhook({
        idempotencyKey,
        holdId,
        userId,
        amount,
        status,
      });

      broadcastUpdate('inventory_changed', { type: 'PAYMENT_EVENT', result });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 6. Payment Simulation Harness (supports normal, duplicate, late, delayed)
  router.post('/payments/simulate', async (req, res) => {
    try {
      const { holdId, userId, mode = 'immediate' } = req.body;
      const result = await paymentService.simulatePayment({ holdId, userId, mode });
      broadcastUpdate('inventory_changed', { type: 'SIMULATION_COMPLETED', result });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 7. Concurrency Stress Test Simulation (Demonstrates 0 oversell under 50+ burst requests)
  router.post('/simulate-rush', async (req, res) => {
    try {
      const count = Number(req.body.count || 50);
      const results = {
        totalRequests: count,
        successfulHolds: 0,
        outOfStock: 0,
        errors: 0,
        details: [],
      };

      // Generate burst of concurrent promises
      const promises = Array.from({ length: count }, (_, i) => {
        const simUserId = `rush_user_${i + 1}`;
        return Promise.resolve()
          .then(() => dropService.requestHold(simUserId, 'drop-1', 300))
          .then((res) => {
            if (res.success) {
              results.successfulHolds++;
              results.details.push({ user: simUserId, status: 'HELD', holdId: res.holdId });
            } else {
              results.outOfStock++;
              results.details.push({ user: simUserId, status: res.reason });
            }
          })
          .catch((err) => {
            results.errors++;
            results.details.push({ user: simUserId, error: err.message });
          });
      });

      await Promise.all(promises);

      const status = dropService.getStatus('admin', 'drop-1');
      broadcastUpdate('inventory_changed', { type: 'RUSH_COMPLETED', results });

      res.json({
        simulation: results,
        currentInventory: status.inventory,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 8. Audit Logs
  router.get('/audit-logs', (req, res) => {
    try {
      const limit = Number(req.query.limit || 30);
      const logs = dropService.getAuditLogs(limit);
      res.json(logs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // 9. Reset System for Fresh Test
  router.post('/admin/reset', (req, res) => {
    try {
      const totalStock = Number(req.body.totalStock || 20);
      resetDatabase(dropService.db, totalStock);
      broadcastUpdate('inventory_changed', { type: 'RESET', totalStock });
      res.json({ success: true, message: `System reset with ${totalStock} pairs.` });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  return router;
}
