# NOTES.md — How to Run & Project Guide

## Prerequisites

- **Node.js v22.0.0 or higher** (uses built-in `node:sqlite` and `node:test` — zero native compilation dependencies)
- **npm v10+**

> This project has **zero external dependencies** beyond Express. No database binaries to compile, no test framework to install.

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Start the server
npm start

# 3. Open in browser
open http://localhost:3000
```

That's it. The SQLite database is created automatically on first run.

## Running Tests

```bash
# Run all 8 automated tests
npm test

# Individual test suites
npm run test:concurrency    # 100 simultaneous buyers → proves 0 overselling
npm run test:idempotency    # Duplicate/late/failed webhook handling
npm run test:limits         # Max 1 hold at a time, max 2 purchases per user
npm run test:waitlist       # FIFO auto-promotion when holds expire
```

## Dev Mode (auto-reload)

```bash
npm run dev
```

## Project Structure

```
src/
├── db/database.js           # SQLite schema with CHECK constraints, WAL mode
├── services/
│   ├── dropService.js       # Core engine: atomic holds, waitlist FIFO promotion
│   ├── paymentService.js    # Idempotent webhook processor + simulation harness
│   └── cleanupWorker.js     # Background worker: expires holds every 1 second
├── controllers/
│   └── apiController.js     # REST API + Server-Sent Events (SSE)
├── public/
│   ├── index.html           # Live dashboard UI
│   ├── app.js               # Client-side state, SSE, countdown timer
│   └── styles.css           # Dark mode design system
└── server.js                # Express bootstrap + graceful shutdown

tests/
├── concurrency.test.js      # 100 buyers → exactly 20 holds (0 oversell)
├── idempotency.test.js      # Duplicate, late, failed webhook scenarios
├── userLimits.test.js       # Max 1 active hold, max 2 purchases
└── waitlist.test.js         # FIFO promotion on hold expiry
```

## How Each Rule is Implemented

### Rule 1: 5-minute hold with auto-expiration
- `dropService.requestHold()` creates a hold with `expires_at = now + 300s`
- `CleanupWorker` ticks every 1 second and calls `expireHolds()` to sweep expired holds
- Expired holds return stock to available or promote the next person in the waitlist

### Rule 2: Max 1 active hold, max 2 total purchases
- Enforced inside `BEGIN IMMEDIATE` transactions — checked before every hold/waitlist action
- Database has a `UNIQUE` partial index on `(user_id, item_id) WHERE status = 'ACTIVE'` as a backstop

### Rule 3: FIFO waitlist with automatic promotion
- When stock hits 0, users join the waitlist (ordered by `joined_at ASC`)
- When a hold expires/cancels, `promoteNextInWaitlist()` finds the earliest eligible user, marks them PROMOTED, and creates a fresh 5-minute hold — the pair never returns to public stock

### Rule 4: Fake payment with messy webhook handling
- `PaymentService` processes webhooks via `idempotency_key` (PRIMARY KEY in `payment_events` table)
- **Duplicate:** Same key → returns DUPLICATE_ACKNOWLEDGED, no double charge
- **Late:** Hold already expired → returns LATE_REFUNDED, no oversell
- **Failed:** Card declined → cancels hold, returns stock or promotes waitlist
- Simulation harness at `POST /api/payments/simulate` with modes: `immediate`, `duplicate`, `late`

### Rule 5: Status page with stock, countdown, queue position
- `GET /api/status?userId=X` returns available pairs, active hold with remaining seconds, and waitlist position
- UI shows live countdown timer (MM:SS) with progress bar
- Server-Sent Events (SSE) push real-time updates to all connected clients

## The Core Anti-Oversell Pattern

The previous system oversold because of a **Check-Then-Act race condition**: multiple requests read `stock > 0` before any of them decremented it.

This system uses three concentric layers of protection:

1. **`BEGIN IMMEDIATE`** — SQLite acquires an exclusive write lock, serializing all concurrent transactions
2. **`UPDATE inventory SET available_stock = available_stock - 1 WHERE available_stock > 0`** — atomic conditional decrement that fails gracefully if another transaction got there first
3. **`CHECK(available_stock >= 0)`** — database-level constraint as the ultimate backstop

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/status?userId=...` | GET | Stock, hold countdown, waitlist position |
| `/api/drop/hold` | POST | Atomically reserve a 5-minute hold |
| `/api/drop/waitlist` | POST | Join FIFO waitlist (only when stock = 0) |
| `/api/drop/cancel` | POST | Cancel active hold |
| `/api/payments/webhook` | POST | Idempotent payment webhook receiver |
| `/api/payments/simulate` | POST | Simulate immediate/duplicate/late webhooks |
| `/api/simulate-rush` | POST | Fire N concurrent buyers for stress testing |
| `/api/admin/reset` | POST | Reset inventory for fresh testing |
| `/api/events` | GET | SSE stream for real-time sync |
| `/api/audit-logs` | GET | Immutable audit trail |
