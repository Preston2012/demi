import { createLogger } from '../config.js';

const log = createLogger('worker-queue');

/**
 * Bounded async worker queue.
 *
 * Ensures embedding computation (and other async work like consensus calls)
 * doesn't create unbounded concurrency. Fixed pool of workers process
 * jobs FIFO. Callers get a promise that resolves when their job completes.
 *
 * Used for:
 * - Embedding computation on write path (never on read hot path)
 * - Consensus LLM calls (multi-eval on ambiguous writes)
 * - Audit snapshot generation
 *
 * NOT used for:
 * - Retrieval (synchronous, deterministic, no queue needed)
 * - FTS5 queries (synchronous)
 * - sqlite-vec queries (synchronous)
 */

export interface QueueJob<T> {
  id: string;
  execute: () => Promise<T>;
}

interface PendingJob<T> {
  job: QueueJob<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
  enqueuedAt: number;
}

export interface QueueStats {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  maxConcurrency: number;
}

export class WorkerQueue {
  private readonly maxConcurrency: number;
  private readonly maxQueueSize: number;
  private readonly pending: PendingJob<unknown>[] = [];
  private active = 0;
  private completed = 0;
  private failed = 0;
  private draining = false;
  private drainResolve: (() => void) | null = null;

  constructor(maxConcurrency: number, maxQueueSize: number) {
    if (maxConcurrency < 1) throw new Error('maxConcurrency must be >= 1');
    if (maxQueueSize < 1) throw new Error('maxQueueSize must be >= 1');
    this.maxConcurrency = maxConcurrency;
    this.maxQueueSize = maxQueueSize;
  }

  /**
   * Enqueue a job. Returns a promise that resolves with the job's result.
   * Rejects if queue is full or draining.
   */
  async enqueue<T>(job: QueueJob<T>): Promise<T> {
    if (this.draining) {
      throw new Error('Queue is draining. No new jobs accepted.');
    }

    if (this.pending.length >= this.maxQueueSize) {
      throw new Error(
        `Queue full (${this.maxQueueSize} pending). Try again later.`,
      );
    }

    return new Promise<T>((resolve, reject) => {
      this.pending.push({
        job: job as QueueJob<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        enqueuedAt: Date.now(),
      });
      this.processNext();
    });
  }

  /**
   * Drain the queue: process all pending jobs, accept no new ones.
   * Resolves when all active + pending jobs complete.
   */
  async drain(): Promise<void> {
    this.draining = true;

    if (this.active === 0 && this.pending.length === 0) {
      this.draining = false;
      return;
    }

    return new Promise<void>((resolve) => {
      this.drainResolve = () => {
        this.draining = false;
        resolve();
      };
      // Kick processing in case workers are idle
      this.processNext();
    });
  }

  getStats(): QueueStats {
    return {
      pending: this.pending.length,
      active: this.active,
      completed: this.completed,
      failed: this.failed,
      maxConcurrency: this.maxConcurrency,
    };
  }

  private processNext(): void {
    while (this.active < this.maxConcurrency && this.pending.length > 0) {
      const item = this.pending.shift()!;
      this.active++;

      const waitMs = Date.now() - item.enqueuedAt;
      if (waitMs > 1000) {
        log.warn({ jobId: item.job.id, waitMs }, 'Job waited >1s in queue');
      }

      item.job
        .execute()
        .then((result) => {
          this.completed++;
          item.resolve(result);
        })
        .catch((err) => {
          this.failed++;
          log.error({ jobId: item.job.id, err }, 'Job failed');
          item.reject(err);
        })
        .finally(() => {
          this.active--;
          this.processNext();
          this.checkDrain();
        });
    }
  }

  private checkDrain(): void {
    if (this.draining && this.active === 0 && this.pending.length === 0) {
      this.drainResolve?.();
      this.drainResolve = null;
    }
  }
}

/**
 * Convenience: create an embedding-specific queue.
 * Concurrency 2 (CPU-bound ONNX inference, don't over-subscribe ARM cores).
 * Queue depth from config.
 */
export function createEmbeddingQueue(queueSize: number): WorkerQueue {
  return new WorkerQueue(2, queueSize);
}

/**
 * Convenience: create a consensus-specific queue.
 * Concurrency 3 (network-bound LLM calls, can overlap).
 * Fixed queue depth of 50.
 */
export function createConsensusQueue(): WorkerQueue {
  return new WorkerQueue(3, 50);
}
