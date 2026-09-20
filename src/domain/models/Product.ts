import { Money } from './Money.js';

export interface ProductProps {
  id: string;
  sku: string;
  name: string;
  unitPrice: Money;
  unitWeightKg: number;
}

export class Product {
  readonly id: string;
  readonly sku: string;
  readonly name: string;
  readonly unitPrice: Money;
  readonly unitWeightKg: number;

  constructor(props: ProductProps) {
    if (!props.id) throw new Error('Product id is required');
    if (!props.sku) throw new Error('Product sku is required');
    if (!props.name) throw new Error('Product name is required');
    if (props.unitWeightKg <= 0)
      throw new Error(`Product unitWeightKg must be positive, received ${props.unitWeightKg}`);

    this.id = props.id;
    this.sku = props.sku;
    this.name = props.name;
    this.unitPrice = props.unitPrice;
    this.unitWeightKg = props.unitWeightKg;
  }

  public get unitWeightGrams(): number {
    return Math.round(this.unitWeightKg * 1000);
  }

  public toJSON() {
    return {
      id: this.id,
      sku: this.sku,
      name: this.name,
      unitPrice: this.unitPrice.toDollars(),
      unitWeightKg: this.unitWeightKg,
      unitWeightGrams: this.unitWeightGrams
    };
  }
}

export const SCOS_STATION_P1_PRO_ENTITY = new Product({
  id: 'prod_scos_p1_pro',
  sku: 'SCOS-P1-PRO',
  name: 'SCOS Station P1 Pro',
  unitPrice: Money.fromDollars(150.0),
  unitWeightKg: 0.365
});

export const SCOS_STATION_P1_PRO = {
  name: SCOS_STATION_P1_PRO_ENTITY.name,
  unitPriceUsd: SCOS_STATION_P1_PRO_ENTITY.unitPrice.toDollars(),
  unitWeightKg: SCOS_STATION_P1_PRO_ENTITY.unitWeightKg,
  unitWeightGrams: SCOS_STATION_P1_PRO_ENTITY.unitWeightGrams
} as const;

export const SHIPPING_RATE_PER_KG_KM = 0.01; // $0.01 per kilogram per kilometer
export const MAX_SHIPPING_COST_RATIO_OF_NET_TOTAL = 0.15; // Max 15% of order amount after discount
