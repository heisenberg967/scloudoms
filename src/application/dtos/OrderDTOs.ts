import { z } from 'zod';

export const CoordinatesInputSchema = z.object({
  latitude: z
    .number({
      required_error: 'Latitude is required',
      invalid_type_error: 'Latitude must be a number'
    })
    .min(-90, 'Latitude must be >= -90')
    .max(90, 'Latitude must be <= 90'),
  longitude: z
    .number({
      required_error: 'Longitude is required',
      invalid_type_error: 'Longitude must be a number'
    })
    .min(-180, 'Longitude must be >= -180')
    .max(180, 'Longitude must be <= 180')
});

export const QuoteOrderInputSchema = z.object({
  quantity: z
    .number({
      required_error: 'Quantity is required',
      invalid_type_error: 'Quantity must be an integer'
    })
    .int('Quantity must be an integer')
    .positive('Quantity must be greater than 0')
    .max(1000000, 'Quantity must be at most 1000000'),
  customerCoordinates: CoordinatesInputSchema
});

export type QuoteOrderInput = z.infer<typeof QuoteOrderInputSchema>;

export const SubmitOrderInputSchema = z.object({
  quantity: z
    .number({
      required_error: 'Quantity is required',
      invalid_type_error: 'Quantity must be an integer'
    })
    .int('Quantity must be an integer')
    .positive('Quantity must be greater than 0')
    .max(1000000, 'Quantity must be at most 1000000'),
  customerCoordinates: CoordinatesInputSchema
});

export type SubmitOrderInput = z.infer<typeof SubmitOrderInputSchema>;

export interface AllocationDTO {
  warehouseId: string;
  warehouseName: string;
  warehouseCoordinates: {
    latitude: number;
    longitude: number;
  };
  distanceKm: number;
  quantity: number;
  weightKg: number;
  shippingCost: number;
}

export interface PricingDTO {
  unitPrice: number;
  quantity: number;
  grossTotal: number;
  discountTier: string;
  discountPercentage: number;
  discountAmount: number;
  netTotal: number;
  currency: string;
}

export interface ShippingDTO {
  ratePerKgKm: number;
  totalWeightKg: number;
  totalDistanceKm: number;
  totalShippingCost: number;
  shippingCostPercentageOfNetTotal: number;
  maxAllowedShippingCost: number;
  maxAllowedPercentage: number;
}

export interface OrderQuoteResponseDTO {
  isValid: boolean;
  validationDetails: {
    status: string;
    reason: string | null;
    isShippingCostValid: boolean;
    isStockAvailable: boolean;
    totalAvailableStock: number;
    requestedQuantity: number;
  };
  pricing: PricingDTO;
  shipping: ShippingDTO;
  allocations: AllocationDTO[];
}

export interface OrderConfirmationResponseDTO {
  orderId: string;
  orderNumber: string;
  idempotencyKey: string | null;
  salesRepId?: string | null;
  status: string;
  createdAt: string;
  pricing: PricingDTO;
  shipping: ShippingDTO;
  allocations: AllocationDTO[];
}

export interface WarehouseResponseDTO {
  id: string;
  name: string;
  coordinates: {
    latitude: number;
    longitude: number;
  };
  stock: number;
  updatedAt: string;
}
