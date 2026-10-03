export class CleanupWorker {
  constructor(dropService, intervalMs = 1000) {
    this.dropService = dropService;
    this.intervalMs = intervalMs;
    this.timer = null;
    this.isRunning = false;
    this.listeners = new Set();
  }

  start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.timer = setInterval(() => {
      this.tick();
    }, this.intervalMs);
  }

  stop() {
    if (!this.isRunning) return;
    clearInterval(this.timer);
    this.timer = null;
    this.isRunning = false;
  }

  tick() {
    try {
      const expiredCount = this.dropService.expireHolds();
      if (expiredCount > 0) {
        this.notifyListeners({ type: 'HOLDS_EXPIRED', count: expiredCount });
      }
    } catch (err) {
      console.error('Error during cleanup worker tick:', err);
    }
  }

  addListener(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notifyListeners(data) {
    for (const listener of this.listeners) {
      try {
        listener(data);
      } catch (err) {
        console.error('Error notifying listener:', err);
      }
    }
  }
}
