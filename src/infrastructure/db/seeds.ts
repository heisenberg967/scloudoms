export const INITIAL_WAREHOUSES_SEED = [
  { id: 'wh_la', name: 'Los Angeles', latitude: 33.9425, longitude: -118.408056, stock: 355 },
  { id: 'wh_ny', name: 'New York', latitude: 40.639722, longitude: -73.778889, stock: 578 },
  { id: 'wh_sp', name: 'São Paulo', latitude: -23.435556, longitude: -46.473056, stock: 265 },
  { id: 'wh_par', name: 'Paris', latitude: 49.009722, longitude: 2.547778, stock: 694 },
  { id: 'wh_waw', name: 'Warsaw', latitude: 52.165833, longitude: 20.967222, stock: 245 },
  { id: 'wh_hk', name: 'Hong Kong', latitude: 22.308889, longitude: 113.914444, stock: 419 }
] as const;

export const INITIAL_PRODUCTS_SEED = [
  {
    id: 'prod_scos_p1_pro',
    sku: 'SCOS-P1-PRO',
    name: 'SCOS Station P1 Pro',
    unit_price_cents: 15000, // $150.00
    unit_weight_grams: 365,
    unit_weight_kg: 0.365
  }
] as const;

export const INITIAL_PRICING_RULES_SEED = [
  {
    id: 'rule_scos_p1_v1',
    rule_name: 'Standard Distance & Volume Pricing Policy',
    shipping_rate_per_kg_km: 0.01,
    max_shipping_cost_ratio: 0.15,
    discount_tiers_json: JSON.stringify([
      { minUnits: 0, maxUnits: 24, discountPercentage: 0, tier: '0%' },
      { minUnits: 25, maxUnits: 49, discountPercentage: 5, tier: '5%' },
      { minUnits: 50, maxUnits: 99, discountPercentage: 10, tier: '10%' },
      { minUnits: 100, maxUnits: 249, discountPercentage: 15, tier: '15%' },
      { minUnits: 250, maxUnits: null, discountPercentage: 20, tier: '20%' }
    ]),
    is_active: 1
  }
] as const;
