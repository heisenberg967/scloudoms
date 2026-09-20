import { Coordinates } from './Coordinates.js';
import { Money } from './Money.js';

export interface AllocationProps {
  warehouseId: string;
  warehouseName: string;
  warehouseCoordinates: Coordinates;
  distanceKm: number;
  quantity: number;
  weightKg: number;
  shippingCost: Money;
}

export class Allocation {
  readonly warehouseId: string;
  readonly warehouseName: string;
  readonly warehouseCoordinates: Coordinates;
  readonly distanceKm: number;
  readonly quantity: number;
  readonly weightKg: number;
  readonly shippingCost: Money;

  constructor(props: AllocationProps) {
    if (!props.warehouseId) throw new Error('Allocation warehouseId is required');
    if (!props.warehouseName) throw new Error('Allocation warehouseName is required');
    if (props.quantity <= 0)
      throw new Error(`Allocation quantity must be positive: ${props.quantity}`);
    if (props.distanceKm < 0)
      throw new Error(`Allocation distance cannot be negative: ${props.distanceKm}`);

    this.warehouseId = props.warehouseId;
    this.warehouseName = props.warehouseName;
    this.warehouseCoordinates = props.warehouseCoordinates;
    this.distanceKm = Number(props.distanceKm.toFixed(2));
    this.quantity = Math.floor(props.quantity);
    this.weightKg = Number(props.weightKg.toFixed(3));
    this.shippingCost = props.shippingCost;
  }

  public toJSON() {
    return {
      warehouseId: this.warehouseId,
      warehouseName: this.warehouseName,
      warehouseCoordinates: this.warehouseCoordinates.toJSON(),
      distanceKm: this.distanceKm,
      quantity: this.quantity,
      weightKg: this.weightKg,
      shippingCost: this.shippingCost.toDollars()
    };
  }
}
