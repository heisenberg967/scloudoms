import { IWarehouseRepository } from '../../domain/repositories/IWarehouseRepository.js';
import { IProductRepository } from '../../domain/repositories/IProductRepository.js';
import { IPricingRuleRepository } from '../../domain/repositories/IPricingRuleRepository.js';
import { Coordinates } from '../../domain/models/Coordinates.js';
import { OrderEvaluator } from '../../domain/services/OrderEvaluator.js';
import { FulfillmentOptimizer } from '../../domain/services/FulfillmentOptimizer.js';
import { QuoteOrderInput, OrderQuoteResponseDTO } from '../dtos/OrderDTOs.js';
import { PricingRuleNotConfiguredError } from '../../domain/errors/DomainErrors.js';

export class QuoteOrderUseCase {
  constructor(
    private readonly warehouseRepo: IWarehouseRepository,
    private readonly productRepo: IProductRepository,
    private readonly pricingRuleRepo?: IPricingRuleRepository
  ) {}

  public async execute(input: QuoteOrderInput): Promise<OrderQuoteResponseDTO> {
    const destination = Coordinates.create(
      input.customerCoordinates.latitude,
      input.customerCoordinates.longitude
    );

    // 1. Fetch Product metadata
    const product = await this.productRepo.getDefaultProduct();

    // 2. Fetch Available Warehouses
    const warehouses = await this.warehouseRepo.findAll();

    // 3. Fetch Active Pricing Rules (Rules as Data)
    let pricingRule = null;
    if (this.pricingRuleRepo) {
      pricingRule = await this.pricingRuleRepo.getActiveRule();
      if (!pricingRule) throw new PricingRuleNotConfiguredError();
    }

    // 4. Domain Evaluation via OrderEvaluator
    const evaluation = OrderEvaluator.evaluate(
      input.quantity,
      destination,
      product,
      warehouses,
      new FulfillmentOptimizer(),
      pricingRule
    );

    return {
      isValid: evaluation.isValid,
      validationDetails: {
        status: evaluation.status,
        reason: evaluation.reason,
        isShippingCostValid: evaluation.status === 'VALID',
        isStockAvailable: evaluation.status !== 'INSUFFICIENT_STOCK',
        totalAvailableStock: evaluation.totalAvailableStock,
        requestedQuantity: evaluation.requestedQuantity
      },
      pricing: {
        unitPrice: evaluation.pricing.unitPrice.toDollars(),
        quantity: evaluation.pricing.quantity,
        grossTotal: evaluation.pricing.grossTotal.toDollars(),
        discountTier: evaluation.pricing.discountTier,
        discountPercentage: evaluation.pricing.discountPercentage,
        discountAmount: evaluation.pricing.discountAmount.toDollars(),
        netTotal: evaluation.pricing.netTotal.toDollars(),
        currency: 'USD'
      },
      shipping: {
        ratePerKgKm: evaluation.shipping.ratePerKgKm,
        totalWeightKg: evaluation.shipping.totalWeightKg,
        totalDistanceKm: evaluation.shipping.totalDistanceKm,
        totalShippingCost: evaluation.shipping.totalShippingCost.toDollars(),
        shippingCostPercentageOfNetTotal: evaluation.shipping.shippingCostPercentageOfNetTotal,
        maxAllowedShippingCost: evaluation.shipping.maxAllowedShippingCost.toDollars(),
        maxAllowedPercentage: evaluation.shipping.maxAllowedPercentage
      },
      allocations: evaluation.allocations.map((a) => ({
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
}
