import { Warehouse } from '../../domain/models/Warehouse.js';

export class MetricsCollector {
  private quotesTotal = 0;
  private ordersSubmittedTotal = 0;
  private ordersFailedInsufficientStockTotal = 0;
  private ordersFailedThresholdTotal = 0;
  private duplicateIdempotencyRequestsTotal = 0;

  public recordQuote(): void {
    this.quotesTotal++;
  }

  public recordOrderSubmitted(): void {
    this.ordersSubmittedTotal++;
  }

  public recordOrderFailedInsufficientStock(): void {
    this.ordersFailedInsufficientStockTotal++;
  }

  public recordOrderFailedThreshold(): void {
    this.ordersFailedThresholdTotal++;
  }

  public recordDuplicateIdempotency(): void {
    this.duplicateIdempotencyRequestsTotal++;
  }

  public getLowStockAlerts(
    warehouses: readonly Warehouse[],
    threshold: number = 50
  ): Array<{ warehouseId: string; name: string; stock: number; threshold: number }> {
    return warehouses
      .filter((w) => w.stock <= threshold)
      .map((w) => ({
        warehouseId: w.id,
        name: w.name,
        stock: w.stock,
        threshold
      }));
  }

  public toPrometheusFormat(warehouses: readonly Warehouse[] = []): string {
    const lines: string[] = [
      '# HELP oms_quotes_total Total number of order quotes requested',
      '# TYPE oms_quotes_total counter',
      `oms_quotes_total ${this.quotesTotal}`,
      '',
      '# HELP oms_orders_submitted_total Total number of confirmed orders placed',
      '# TYPE oms_orders_submitted_total counter',
      `oms_orders_submitted_total ${this.ordersSubmittedTotal}`,
      '',
      '# HELP oms_orders_failed_insufficient_stock_total Orders rejected due to lack of network inventory (HTTP 409)',
      '# TYPE oms_orders_failed_insufficient_stock_total counter',
      `oms_orders_failed_insufficient_stock_total ${this.ordersFailedInsufficientStockTotal}`,
      '',
      '# HELP oms_orders_failed_threshold_total Orders rejected due to shipping cost exceeding 15% threshold (HTTP 422)',
      '# TYPE oms_orders_failed_threshold_total counter',
      `oms_orders_failed_threshold_total ${this.ordersFailedThresholdTotal}`,
      '',
      '# HELP oms_duplicate_idempotency_requests_total Concurrent or repeat requests resolved idempotently',
      '# TYPE oms_duplicate_idempotency_requests_total counter',
      `oms_duplicate_idempotency_requests_total ${this.duplicateIdempotencyRequestsTotal}`,
      '',
      '# HELP oms_process_uptime_seconds Total uptime of the Node.js OMS process in seconds',
      '# TYPE oms_process_uptime_seconds gauge',
      `oms_process_uptime_seconds ${process.uptime()}`,
      ''
    ];

    if (warehouses.length > 0) {
      lines.push(
        '# HELP oms_warehouse_stock_units Current on-hand stock units per warehouse',
        '# TYPE oms_warehouse_stock_units gauge'
      );
      for (const w of warehouses) {
        lines.push(
          `oms_warehouse_stock_units{warehouse_id="${w.id}",warehouse_name="${w.name}"} ${w.stock}`
        );
      }
      lines.push('');

      lines.push(
        '# HELP oms_warehouse_low_stock_alert Alert indicator (1 = stock <= 50 units, 0 = healthy)',
        '# TYPE oms_warehouse_low_stock_alert gauge'
      );
      for (const w of warehouses) {
        const isLow = w.stock <= 50 ? 1 : 0;
        lines.push(
          `oms_warehouse_low_stock_alert{warehouse_id="${w.id}",warehouse_name="${w.name}"} ${isLow}`
        );
      }
      lines.push('');
    }

    return lines.join('\n');
  }

}
