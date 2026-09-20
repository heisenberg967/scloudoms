import { Product } from '../models/Product.js';

export interface IProductRepository {
  getDefaultProduct(): Promise<Product>;
}
