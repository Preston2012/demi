/**
 * Demiurge error hierarchy.
 * Single typed union. No string matching. Catch by class.
 */

export class DemiurgeError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(message: string, code: string, statusCode: number) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.statusCode = statusCode;
  }

  toJSON() {
    return {
      error: this.name,
      code: this.code,
      message: this.message,
      statusCode: this.statusCode,
    };
  }
}

// --- Write path ---

export class DuplicateMemoryError extends DemiurgeError {
  readonly existingId: string;

  constructor(existingId: string) {
    super(
      `Duplicate memory detected. Existing ID: ${existingId}`,
      'DUPLICATE_MEMORY',
      409,
    );
    this.existingId = existingId;
  }
}

export class ConflictDetectedError extends DemiurgeError {
  readonly conflictsWith: string[];

  constructor(conflictsWith: string[]) {
    super(
      `Memory conflicts with ${conflictsWith.length} existing memories`,
      'CONFLICT_DETECTED',
      409,
    );
    this.conflictsWith = conflictsWith;
  }
}

export class ValidationError extends DemiurgeError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.field = field;
  }
}

export class ConsensusFailedError extends DemiurgeError {
  readonly votes: Record<string, string>;

  constructor(votes: Record<string, string>) {
    super('Consensus evaluators could not reach agreement', 'CONSENSUS_FAILED', 500);
    this.votes = votes;
  }
}

export class RateLimitError extends DemiurgeError {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super('Rate limit exceeded', 'RATE_LIMIT', 429);
    this.retryAfterMs = retryAfterMs;
  }
}

export class InjectionDetectedError extends DemiurgeError {
  readonly pattern: string;

  constructor(pattern: string) {
    super('Potential prompt injection detected in memory content', 'INJECTION_DETECTED', 400);
    this.pattern = pattern;
  }
}

// --- Read path ---

export class MemoryNotFoundError extends DemiurgeError {
  constructor(id: string) {
    super(`Memory not found: ${id}`, 'MEMORY_NOT_FOUND', 404);
  }
}

export class CircuitBreakerActiveError extends DemiurgeError {
  readonly lockedSince: string;

  constructor(lockedSince: string) {
    super(
      `System locked due to inactivity since ${lockedSince}. Any write operation will unlock.`,
      'CIRCUIT_BREAKER_ACTIVE',
      503,
    );
    this.lockedSince = lockedSince;
  }
}

// --- System ---

export class EmbeddingError extends DemiurgeError {
  constructor(message: string) {
    super(message, 'EMBEDDING_ERROR', 500);
  }
}

export class DatabaseError extends DemiurgeError {
  constructor(message: string) {
    super(message, 'DATABASE_ERROR', 500);
  }
}

export class AuditIntegrityError extends DemiurgeError {
  readonly entryId: string;

  constructor(entryId: string, message: string) {
    super(message, 'AUDIT_INTEGRITY', 500);
    this.entryId = entryId;
  }
}

export class AuthenticationError extends DemiurgeError {
  constructor() {
    super('Invalid or missing authentication token', 'AUTH_ERROR', 401);
  }
}
