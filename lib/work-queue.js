/**
 * Simple async work queue with concurrency control
 */
class WorkQueue {
  constructor(concurrency = 1) {
    this.concurrency = concurrency;
    this.running = 0;
    this.queue = [];
    this.results = [];
    this.errors = [];
  }

  async add(task, id = null) {
    return new Promise((resolve, reject) => {
      this.queue.push({ task, id, resolve, reject });
      this.process();
    });
  }

  async process() {
    while (this.running < this.concurrency && this.queue.length > 0) {
      const { task, id, resolve, reject } = this.queue.shift();
      this.running++;
      
      try {
        const result = await task();
        this.results.push({ id, result });
        resolve(result);
      } catch (error) {
        this.errors.push({ id, error });
        reject(error);
      } finally {
        this.running--;
        this.process();
      }
    }
  }

  async drain() {
    while (this.running > 0 || this.queue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  get pending() {
    return this.queue.length;
  }

  get active() {
    return this.running;
  }
}

/**
 * Round-robin load balancer for multiple endpoints
 */
class LoadBalancer {
  constructor(endpoints) {
    this.endpoints = endpoints;
    this.index = 0;
    this.stats = endpoints.map(() => ({ requests: 0, errors: 0, totalTime: 0 }));
  }

  next() {
    const endpoint = this.endpoints[this.index];
    const statIndex = this.index;
    this.index = (this.index + 1) % this.endpoints.length;
    return { endpoint, statIndex };
  }

  recordSuccess(index, time) {
    this.stats[index].requests++;
    this.stats[index].totalTime += time;
  }

  recordError(index) {
    this.stats[index].errors++;
  }

  getStats() {
    return this.endpoints.map((endpoint, i) => ({
      endpoint,
      requests: this.stats[i].requests,
      errors: this.stats[i].errors,
      avgTime: this.stats[i].requests > 0 
        ? Math.round(this.stats[i].totalTime / this.stats[i].requests) 
        : 0
    }));
  }
}

/**
 * Progress tracker with ETA
 */
class ProgressTracker {
  constructor(total) {
    this.total = total;
    this.completed = 0;
    this.startTime = Date.now();
    this.times = [];
  }

  tick(processingTime = null) {
    this.completed++;
    if (processingTime) {
      this.times.push(processingTime);
      // Keep only last 50 for moving average
      if (this.times.length > 50) this.times.shift();
    }
  }

  get percentage() {
    return Math.round((this.completed / this.total) * 100);
  }

  get eta() {
    if (this.completed === 0) return 'calculating...';
    
    const avgTime = this.times.length > 0
      ? this.times.reduce((a, b) => a + b, 0) / this.times.length
      : (Date.now() - this.startTime) / this.completed;
    
    const remaining = this.total - this.completed;
    const etaMs = remaining * avgTime;
    
    if (etaMs < 60000) return `${Math.round(etaMs / 1000)}s`;
    if (etaMs < 3600000) return `${Math.round(etaMs / 60000)}m`;
    return `${(etaMs / 3600000).toFixed(1)}h`;
  }

  get elapsed() {
    const ms = Date.now() - this.startTime;
    if (ms < 60000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3600000) return `${Math.round(ms / 60000)}m`;
    return `${(ms / 3600000).toFixed(1)}h`;
  }

  toString() {
    return `[${this.completed}/${this.total}] ${this.percentage}% | Elapsed: ${this.elapsed} | ETA: ${this.eta}`;
  }
}

module.exports = { WorkQueue, LoadBalancer, ProgressTracker };
