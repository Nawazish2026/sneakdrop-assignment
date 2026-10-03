import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

let dbInstance = null;

export function getDatabase(dbFilePath = ':memory:') {
  if (dbInstance && dbFilePath === ':memory:') {
    return dbInstance;
  }

  // Ensure directory exists if saving to a file
  if (dbFilePath !== ':memory:') {
    const dir = path.dirname(dbFilePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  const db = new DatabaseSync(dbFilePath);

  // Enable WAL mode and foreign keys for high-performance and strict data integrity
  db.exec('PRAGMA foreign_keys = ON;');
  if (dbFilePath !== ':memory:') {
    db.exec('PRAGMA journal_mode = WAL;');
  }

  initSchema(db);

  if (dbFilePath === ':memory:') {
    dbInstance = db;
  }

  return db;
}

export function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS inventory (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      total_stock INTEGER NOT NULL,
      available_stock INTEGER NOT NULL CHECK(available_stock >= 0),
      held_stock INTEGER NOT NULL DEFAULT 0 CHECK(held_stock >= 0),
      sold_stock INTEGER NOT NULL DEFAULT 0 CHECK(sold_stock >= 0)
    );

    CREATE TABLE IF NOT EXISTS holds (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('ACTIVE', 'PAID', 'EXPIRED', 'CANCELLED', 'REFUNDED')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES inventory(id)
    );

    CREATE INDEX IF NOT EXISTS idx_holds_user_status ON holds(user_id, status);
    CREATE INDEX IF NOT EXISTS idx_holds_status_expires ON holds(status, expires_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_holds_unique_active ON holds(user_id, item_id) WHERE status = 'ACTIVE';

    CREATE TABLE IF NOT EXISTS purchases (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      hold_id TEXT UNIQUE NOT NULL,
      payment_event_id TEXT UNIQUE NOT NULL,
      amount INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (item_id) REFERENCES inventory(id),
      FOREIGN KEY (hold_id) REFERENCES holds(id)
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);

    CREATE TABLE IF NOT EXISTS waitlist (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('WAITING', 'PROMOTED', 'CANCELLED')),
      joined_at INTEGER NOT NULL,
      promoted_at INTEGER,
      FOREIGN KEY (item_id) REFERENCES inventory(id)
    );

    CREATE INDEX IF NOT EXISTS idx_waitlist_item_status_joined ON waitlist(item_id, status, joined_at);
    CREATE INDEX IF NOT EXISTS idx_waitlist_user_status ON waitlist(user_id, status);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_waitlist_unique_waiting ON waitlist(user_id, item_id) WHERE status = 'WAITING';

    CREATE TABLE IF NOT EXISTS payment_events (
      idempotency_key TEXT PRIMARY KEY,
      hold_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('PROCESSED', 'DUPLICATE_IGNORED', 'LATE_REFUNDED', 'REJECTED')),
      details TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      user_id TEXT,
      details TEXT,
      created_at INTEGER NOT NULL
    );
  `);
}

export function seedInventory(db, { id = 'drop-1', name = 'Air Velocity Limited Edition', totalStock = 20 } = {}) {
  const existing = db.prepare('SELECT id FROM inventory WHERE id = ?').get(id);
  if (!existing) {
    db.prepare(`
      INSERT INTO inventory (id, name, total_stock, available_stock, held_stock, sold_stock)
      VALUES (?, ?, ?, ?, 0, 0)
    `).run(id, name, totalStock, totalStock);
  }
}

export function resetDatabase(db, totalStock = 20) {
  db.exec(`
    DELETE FROM purchases;
    DELETE FROM payment_events;
    DELETE FROM holds;
    DELETE FROM waitlist;
    DELETE FROM audit_log;
    DELETE FROM inventory;
  `);
  seedInventory(db, { id: 'drop-1', name: 'Air Velocity Limited Edition', totalStock });
}
