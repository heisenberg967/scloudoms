import { Warehouse } from '../models/Warehouse.js';

export interface IWarehouseRepository {
  /**
   * Retrieves all warehouses in the fulfillment network.
   */
  findAll(): Promise<Warehouse[]>;

  /**
   * Retrieves a warehouse by unique identifier.
   */
  findById(id: string): Promise<Warehouse | null>;

  /**
   * Atomically deducts inventory from a warehouse.
   * Throws InsufficientStockError if warehouse stock is less than quantity.
   */
  deductStock(id: string, quantity: number): Promise<void>;
}
