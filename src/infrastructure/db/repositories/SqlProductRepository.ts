import { IProductRepository } from '../../../domain/repositories/IProductRepository.js';
import { Product } from '../../../domain/models/Product.js';
import { Money } from '../../../domain/models/Money.js';
import { SqlConnection } from '../PostgresClient.js';

export class SqlProductRepository implements IProductRepository {
  constructor(private readonly db: SqlConnection) {}
  async getDefaultProduct(): Promise<Product> {
    const product = await this.findBySku('SCOS-P1-PRO');
    if (!product) throw new Error('Default product is not configured');
    return product;
  }
  private async findBySku(sku: string): Promise<Product | null> {
    return this.read('SELECT * FROM products WHERE sku = $1', sku);
  }
  private async read(sql: string, value: string): Promise<Product | null> {
    const [r] = await this.db.query(sql, [value]);
    return r
      ? new Product({
          id: r.id,
          sku: r.sku,
          name: r.name,
          unitPrice: Money.fromCents(r.unit_price_cents),
          unitWeightKg: r.unit_weight_grams / 1000
        })
      : null;
  }
}
