import { Order } from '../models/Order.js';

export interface IOrderRepository {
  /**
   * Persists a new order and its line allocations.
   */
  save(order: Order): Promise<void>;

  /**
   * Retrieves an order by its unique customer-facing orderNumber (date plus UUID).
   */
  findByOrderNumber(orderNumber: string): Promise<Order | null>;

  /**
   * Retrieves an order by internal database ID.
   */
  findById(id: string): Promise<Order | null>;

}
