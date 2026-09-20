const number = { type: 'number' };
const string = { type: 'string' };
const integer = { type: 'integer' };
const nullableString = { type: 'string', nullable: true };
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  properties,
  required: Object.keys(properties)
});
export const coordinatesSchema = object({ latitude: number, longitude: number });
export const pricingSchema = object({
  unitPrice: number,
  quantity: integer,
  grossTotal: number,
  discountTier: string,
  discountPercentage: number,
  discountAmount: number,
  netTotal: number,
  currency: string
});
export const shippingSchema = object({
  ratePerKgKm: number,
  totalWeightKg: number,
  totalDistanceKm: number,
  totalShippingCost: number,
  shippingCostPercentageOfNetTotal: number,
  maxAllowedShippingCost: number,
  maxAllowedPercentage: number
});
export const allocationsSchema = {
  type: 'array',
  items: object({
    warehouseId: string,
    warehouseName: string,
    warehouseCoordinates: coordinatesSchema,
    distanceKm: number,
    quantity: integer,
    weightKg: number,
    shippingCost: number
  })
};
export const orderSchema = object({
  orderId: string,
  orderNumber: string,
  idempotencyKey: nullableString,
  salesRepId: nullableString,
  status: string,
  createdAt: string,
  pricing: pricingSchema,
  shipping: shippingSchema,
  allocations: allocationsSchema
});
export const quoteResponseSchema = object({
  isValid: { type: 'boolean' },
  validationDetails: object({
    status: string,
    reason: nullableString,
    isShippingCostValid: { type: 'boolean' },
    isStockAvailable: { type: 'boolean' },
    totalAvailableStock: integer,
    requestedQuantity: integer
  }),
  pricing: pricingSchema,
  shipping: shippingSchema,
  allocations: allocationsSchema
});
export const problemSchema = {
  type: 'object',
  required: ['type', 'title', 'status', 'detail'],
  properties: {
    type: string,
    title: string,
    status: integer,
    detail: string,
    errors: { type: 'array', items: object({ field: string, message: string }) }
  }
};
export const errors = Object.fromEntries(
  [400, 401, 404, 409, 413, 415, 422, 500, 503].map((status) => [
    status,
    {
      content: { 'application/problem+json': { schema: problemSchema } },
      description: (
        {
          400: 'Invalid input or malformed JSON',
          401: 'Invalid bearer token',
          404: 'Order not found',
          409: 'Insufficient stock or conflicting idempotency key',
          413: 'Request body too large',
          415: 'Unsupported content type',
          422: 'Shipping exceeds the allowed threshold',
          500: 'Unexpected server error',
          503: 'Database contention; retry with the same key'
        } as Record<number, string>
      )[status]
    }
  ])
);
