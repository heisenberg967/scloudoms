import { IOrderRepository } from '../../domain/repositories/IOrderRepository.js';
import { OrderNotFoundError } from '../../domain/errors/DomainErrors.js';
import { mapOrder } from '../dtos/mapOrder.js';

export class GetOrderUseCase {
  constructor(private readonly orders: IOrderRepository) {}
  async execute(orderNumber: string) {
    const order = await this.orders.findByOrderNumber(orderNumber);
    if (!order) throw new OrderNotFoundError(orderNumber);
    return mapOrder(order);
  }
}
