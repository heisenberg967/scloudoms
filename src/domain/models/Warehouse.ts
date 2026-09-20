import { Coordinates } from './Coordinates.js';

export interface WarehouseProps {
  id: string;
  name: string;
  coordinates: Coordinates;
  stock: number;
  updatedAt?: Date;
}

export class Warehouse {
  readonly id: string;
  readonly name: string;
  readonly coordinates: Coordinates;
  private _stock: number;
  private _updatedAt: Date;

  constructor(props: WarehouseProps) {
    if (!props.id) throw new Error('Warehouse id is required');
    if (!props.name) throw new Error('Warehouse name is required');
    if (props.stock < 0) throw new Error(`Warehouse stock cannot be negative: ${props.stock}`);

    this.id = props.id;
    this.name = props.name;
    this.coordinates = props.coordinates;
    this._stock = Math.floor(props.stock);
    this._updatedAt = props.updatedAt ?? new Date();
  }

  public get stock(): number {
    return this._stock;
  }

  public get updatedAt(): Date {
    return this._updatedAt;
  }

  public deductStock(quantity: number): void {
    if (quantity < 0) {
      throw new Error(`Cannot deduct negative quantity: ${quantity}`);
    }
    if (this._stock < quantity) {
      throw new Error(
        `Cannot deduct ${quantity} units from warehouse ${this.name} (${this.id}): only ${this._stock} available.`
      );
    }
    this._stock -= quantity;
    this._updatedAt = new Date();
  }

  public toJSON() {
    return {
      id: this.id,
      name: this.name,
      coordinates: this.coordinates.toJSON(),
      stock: this._stock,
      updatedAt: this._updatedAt.toISOString()
    };
  }
}
