import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDatabase, seedInventory } from './db/database.js';
import { DropService } from './services/dropService.js';
import { PaymentService } from './services/paymentService.js';
import { CleanupWorker } from './services/cleanupWorker.js';
import { createApiController } from './controllers/apiController.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp({ dbPath = path.join(__dirname, '../data/sneakdrop.db'), totalStock = 20 } = {}) {
  const db = getDatabase(dbPath);
  seedInventory(db, { id: 'drop-1', name: 'Air Velocity Limited Edition', totalStock });

  const dropService = new DropService(db);
  const paymentService = new PaymentService(db, dropService);
  const cleanupWorker = new CleanupWorker(dropService, 1000);

  cleanupWorker.start();

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, 'public')));

  const apiRouter = createApiController({ dropService, paymentService, cleanupWorker });
  app.use('/api', apiRouter);

  // Fallback to index.html
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(__dirname, 'public/index.html'));
  });

  return { app, db, dropService, paymentService, cleanupWorker };
}

// Start server directly if executed
if (process.env.NODE_ENV !== 'test' && !process.env.TEST_RUNNER) {
  const PORT = process.env.PORT || 3000;
  const { app, cleanupWorker } = createApp();

  const server = app.listen(PORT, () => {
    console.log(`\n======================================================`);
    console.log(`👟 SNEAKER DROP ENGINE RUNNING ON http://localhost:${PORT}`);
    console.log(`======================================================`);
    console.log(`- Rule 1: 5-minute hold on Buy with auto-expiration`);
    console.log(`- Rule 2: Max 1 hold at a time, max 2 purchases per user`);
    console.log(`- Rule 3: Waitlist FIFO promotion when hold expires`);
    console.log(`- Rule 4: Idempotent payment webhook & late-refund handling`);
    console.log(`- Rule 5: Real-time UI with pairs left, countdown & queue position`);
    console.log(`======================================================\n`);
  });

  const shutdown = () => {
    console.log('\nGracefully shutting down...');
    cleanupWorker.stop();
    server.close(() => {
      console.log('Server stopped.');
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
