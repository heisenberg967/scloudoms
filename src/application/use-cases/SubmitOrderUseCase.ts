import { createHash, randomUUID } from 'node:crypto';
import { Coordinates } from '../../domain/models/Coordinates.js';
import { Order } from '../../domain/models/Order.js';
import { OrderEvaluator } from '../../domain/services/OrderEvaluator.js';
import {
  InsufficientStockError,
  OrderInvalidThresholdError
} from '../../domain/errors/DomainErrors.js';
import { IOrderUnitOfWork } from '../ports/IOrderUnitOfWork.js';
import { SubmitOrderInput, SubmitOrderInputSchema } from '../dtos/OrderDTOs.js';
import { mapOrder } from '../dtos/mapOrder.js';

export interface SubmitOrderOptions {
  idempotencyKey?: string | null;
  salesRepId?: string | null;
}

export class SubmitOrderUseCase {
  constructor(private readonly unitOfWork: IOrderUnitOfWork) {}

  async execute(rawInput: SubmitOrderInput, options: SubmitOrderOptions = {}) {
    const input = SubmitOrderInputSchema.parse(rawInput);
    const idempotencyKey = options.idempotencyKey?.trim() || null;
    const salesRepId = options.salesRepId?.trim() || null;
    const destination = Coordinates.create(
      input.customerCoordinates.latitude,
      input.customerCoordinates.longitude
    );
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify([input.quantity, destination.latitude, destination.longitude, salesRepId])
      )
      .digest('hex');
    const id = randomUUID();
    const orderNumber = `SC-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}-${randomUUID()}`;

    return this.unitOfWork.run(async (tx) => {
      if (idempotencyKey) {
        const existing = await tx.claimIdempotency(idempotencyKey, fingerprint, id, orderNumber);
        if (existing) return { ...mapOrder(existing), replayed: true };
      }
      const warehouses = await tx.lockWarehouses();
      const product = await tx.products.getDefaultProduct();
      const rule = await tx.pricingRules.getActiveRule();
      const evaluation = OrderEvaluator.evaluate(
        input.quantity,
        destination,
        product,
        warehouses,
        undefined,
        rule
      );
      if (evaluation.status === 'INSUFFICIENT_STOCK')
        throw new InsufficientStockError(input.quantity, evaluation.totalAvailableStock);
      if (!evaluation.isValid) {
        const s = evaluation.shipping;
        throw new OrderInvalidThresholdError(
          s.totalShippingCost.toDollars(),
          evaluation.pricing.netTotal.toDollars(),
          s.shippingCostPercentageOfNetTotal,
          s.maxAllowedShippingCost.toDollars(),
          s.maxAllowedPercentage
        );
      }
      const order = new Order({
        id,
        orderNumber,
        idempotencyKey,
        salesRepId,
        pricingRuleId: rule?.id,
        quantity: input.quantity,
        shippingCoordinates: destination,
        pricing: evaluation.pricing,
        shipping: evaluation.shipping,
        allocations: evaluation.allocations
      });
      await tx.orders.save(order);
      await tx.fulfill(order);
      return { ...mapOrder(order), replayed: false };
    });
  }
}
