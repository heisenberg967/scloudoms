import { Order } from '../../domain/models/Order.js';
import { OrderConfirmationResponseDTO } from './OrderDTOs.js';

export function mapOrder(order: Order): OrderConfirmationResponseDTO {
  const snapshot = order.toJSON();
  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    idempotencyKey: order.idempotencyKey,
    salesRepId: order.salesRepId,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    pricing: snapshot.pricing,
    shipping: snapshot.shipping,
    allocations: order.allocations.map((a) => ({
      warehouseId: a.warehouseId,
      warehouseName: a.warehouseName,
      warehouseCoordinates: {
        latitude: a.warehouseCoordinates.latitude,
        longitude: a.warehouseCoordinates.longitude
      },
      distanceKm: a.distanceKm,
      quantity: a.quantity,
      weightKg: a.weightKg,
      shippingCost: a.shippingCost.toDollars()
    }))
  };
}
