import { IWarehouseRepository } from '../../../domain/repositories/IWarehouseRepository.js';
import { Warehouse } from '../../../domain/models/Warehouse.js';
import { Coordinates } from '../../../domain/models/Coordinates.js';
import { InsufficientStockError } from '../../../domain/errors/DomainErrors.js';
import { SqlConnection } from '../PostgresClient.js';

export class SqlWarehouseRepository implements IWarehouseRepository {
  constructor(private readonly db: SqlConnection) {}
  async findAll(): Promise<Warehouse[]> {
    return this.read('SELECT * FROM warehouses ORDER BY id');
  }
  async lockAll(): Promise<Warehouse[]> {
    return this.read('SELECT * FROM warehouses ORDER BY id FOR UPDATE');
  }
  async findById(id: string): Promise<Warehouse | null> {
    return (await this.read('SELECT * FROM warehouses WHERE id = $1', [id]))[0] ?? null;
  }
  async deductStock(id: string, quantity: number): Promise<void> {
    if (!Number.isSafeInteger(quantity) || quantity <= 0)
      throw new Error('Deduction must be a positive integer');
    const rows = await this.db.query(
      'UPDATE warehouses SET stock = stock - $1, updated_at = NOW() WHERE id = $2 AND stock >= $1 RETURNING stock',
      [quantity, id]
    );
    if (!rows.length)
      throw new InsufficientStockError(quantity, (await this.findById(id))?.stock ?? 0);
  }
  private async read(sql: string, values: unknown[] = []): Promise<Warehouse[]> {
    return (await this.db.query(sql, values)).map(
      (r) =>
        new Warehouse({
          id: r.id,
          name: r.name,
          coordinates: Coordinates.create(r.latitude, r.longitude),
          stock: r.stock,
          updatedAt: new Date(r.updated_at)
        })
    );
  }
}
