/**
 * Phase 0 of the DDD migration — the domain event bus contract.
 * See docs/DDD_ARCHITECTURE.md (§4) and docs/DDD_MIGRATION_PLAN.md (Phase 0).
 */

export interface DomainEventEnvelope<T = Record<string, unknown>> {
  id: string;
  type: string;                 // e.g. "billing.PaymentCaptured"
  version: number;
  occurredAt: Date;
  subjectRef: string | null;    // who/what it's about, e.g. "order:uuid"
  correlationId: string | null; // ties a saga together
  causationId: string | null;   // the event/command that caused this
  payload: T;
}

export interface PublishInput {
  type: string;
  payload?: Record<string, unknown>;
  version?: number;
  subjectRef?: string | null;
  correlationId?: string | null;
  causationId?: string | null;
}

/**
 * A subscriber. Handlers must be idempotent — the dispatcher guarantees
 * at-least-once delivery and dedupes per (event, consumer name).
 */
export interface DomainEventHandler {
  readonly name: string;
  handles(type: string): boolean;
  handle(event: DomainEventEnvelope): Promise<void>;
}
