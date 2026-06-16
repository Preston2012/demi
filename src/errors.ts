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

export class ValidationError extends DemiurgeError {
  readonly field?: string;

  constructor(message: string, field?: string) {
    super(message, 'VALIDATION_ERROR', 400);
    this.field = field;
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
