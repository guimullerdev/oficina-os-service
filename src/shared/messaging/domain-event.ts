export interface DomainEvent {
  evento: string;
  aggregateType: string;
  aggregateId: string;
  payload: Record<string, unknown>;
  correlationId: string;
  traceparent?: string;
}
