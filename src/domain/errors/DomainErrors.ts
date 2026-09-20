export abstract class DomainError extends Error {
  abstract readonly code: string;
  abstract readonly statusCode: number;

  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class InsufficientStockError extends DomainError {
  readonly code = 'INSUFFICIENT_STOCK';
  readonly statusCode = 409;

  constructor(
    readonly requestedQuantity: number,
    readonly availableStock: number
  ) {
    super(
      `Insufficient network inventory: Requested ${requestedQuantity} units, but only ${availableStock} units are currently available across all warehouses.`
    );
  }
}

export class OrderInvalidThresholdError extends DomainError {
  readonly code = 'ORDER_SHIPPING_COST_EXCEEDS_THRESHOLD';
  readonly statusCode = 422;

  constructor(
    readonly shippingCost: number,
    readonly netTotal: number,
    readonly shippingRatioPct: number,
    readonly maxAllowedShippingCost: number,
    readonly thresholdPct: number = 15
  ) {
    super(
      `Order is invalid: Shipping cost of $${shippingCost.toFixed(2)} (${shippingRatioPct.toFixed(2)}% of net order amount $${netTotal.toFixed(2)}) exceeds the maximum allowed threshold of ${thresholdPct}% ($${maxAllowedShippingCost.toFixed(2)}).`
    );
  }
}

export class InvalidCoordinatesError extends DomainError {
  readonly code = 'INVALID_COORDINATES';
  readonly statusCode = 400;

  constructor(message: string) {
    super(message);
  }
}

export class OrderNotFoundError extends DomainError {
  readonly code = 'ORDER_NOT_FOUND';
  readonly statusCode = 404;

  constructor(orderNumber: string) {
    super(`Order with order number '${orderNumber}' was not found.`);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  readonly statusCode = 409;
  constructor() {
    super(
      'This idempotency key was already used for a different request. Use a new key for a new order.'
    );
  }
}
export class ServiceBusyError extends DomainError {
  readonly code = 'SERVICE_BUSY';
  readonly statusCode = 503;
  constructor() {
    super('Inventory is busy. Retry with the same idempotency key.');
  }
}
