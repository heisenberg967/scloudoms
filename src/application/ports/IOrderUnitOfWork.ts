import { IOrderRepository } from '../../domain/repositories/IOrderRepository.js';
import { IProductRepository } from '../../domain/repositories/IProductRepository.js';
import { IPricingRuleRepository } from '../../domain/repositories/IPricingRuleRepository.js';
import { Warehouse } from '../../domain/models/Warehouse.js';
import { Order } from '../../domain/models/Order.js';

export interface OrderTransaction {
  orders: IOrderRepository;
  products: IProductRepository;
  pricingRules: IPricingRuleRepository;
  claimIdempotency(
    key: string,
    hash: string,
    orderId: string,
    orderNumber: string
  ): Promise<Order | null>;
  lockWarehouses(): Promise<Warehouse[]>;
  fulfill(order: Order): Promise<void>;
}

export interface IOrderUnitOfWork {
  run<T>(work: (transaction: OrderTransaction) => Promise<T>): Promise<T>;
}
