import { quoteResponseSchema, orderSchema, errors } from './schemas.js';
import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { ZodError } from 'zod';
import { QuoteOrderUseCase } from '../../application/use-cases/QuoteOrderUseCase.js';
import { SubmitOrderUseCase } from '../../application/use-cases/SubmitOrderUseCase.js';
import { GetOrderUseCase } from '../../application/use-cases/GetOrderUseCase.js';
import { ListWarehousesUseCase } from '../../application/use-cases/ListWarehousesUseCase.js';
import { QuoteOrderInputSchema, SubmitOrderInputSchema } from '../../application/dtos/OrderDTOs.js';
import { DomainError } from '../../domain/errors/DomainErrors.js';
import { PostgresClient } from '../../infrastructure/db/PostgresClient.js';
import { MetricsCollector } from '../../infrastructure/monitoring/MetricsCollector.js';

export interface RouteDependencies {
  quoteOrderUseCase: QuoteOrderUseCase;
  submitOrderUseCase: SubmitOrderUseCase;
  getOrderUseCase: GetOrderUseCase;
  listWarehousesUseCase: ListWarehousesUseCase;
  dbClient: PostgresClient;
}

export function createRoutes(deps: RouteDependencies): FastifyPluginAsync {
  const metrics = new MetricsCollector();

  return async (app: FastifyInstance) => {
    // Correlation headers; this is not distributed tracing instrumentation.
    app.addHook('onSend', async (request, reply) => {
      const reqId = request.id;
      reply.header('x-request-id', reqId);
    });

    // Global RFC 7807 Error Handler
    app.setErrorHandler((error, _request, reply) => {
      reply.header('content-type', 'application/problem+json');

      if ((error as any).validation || (error as any).code === 'FST_ERR_VALIDATION') {
        return reply.status(400).send({
          type: 'https://screencloud.com/errors/validation-error',
          title: 'Bad Request',
          status: 400,
          detail: (error as any).message || 'One or more request validation constraints failed.',
          errors: ((error as any).validation || []).map((v: any) => ({
            field: v.instancePath || v.params?.missingProperty || '',
            message: v.message || 'Invalid value'
          }))
        });
      }

      if (error instanceof ZodError) {
        return reply.status(400).send({
          type: 'https://screencloud.com/errors/validation-error',
          title: 'Bad Request',
          status: 400,
          detail: 'One or more request validation constraints failed.',
          errors: error.errors.map((e) => ({
            field: e.path.join('.'),
            message: e.message
          }))
        });
      }

      if (error instanceof DomainError) {
        if (error.code === 'INSUFFICIENT_STOCK') {
          metrics.recordOrderFailedInsufficientStock();
        } else if (error.code === 'ORDER_SHIPPING_COST_EXCEEDS_THRESHOLD') {
          metrics.recordOrderFailedThreshold();
        }

        return reply.status(error.statusCode).send({
          type: `https://screencloud.com/errors/${error.code.toLowerCase().replace(/_/g, '-')}`,
          title: error.code,
          status: error.statusCode,
          detail: error.message
        });
      }

      const httpError = error as { statusCode?: number; message?: string };
      if (httpError.statusCode && httpError.statusCode >= 400 && httpError.statusCode < 500) {
        return reply
          .status(httpError.statusCode)
          .send({
            type: 'about:blank',
            title: 'Invalid Request',
            status: httpError.statusCode,
            detail: httpError.message
          });
      }
      app.log.error(error);
      return reply.status(500).send({
        type: 'https://screencloud.com/errors/internal-server-error',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected internal server error occurred.'
      });
    });

    // Health check (liveness probe)
    app.get(
      '/health',
      {
        schema: {
          description: 'Health check and liveness probe',
          tags: ['Health'],
          security: [],
          response: {
            200: {
              type: 'object',
              properties: {
                status: { type: 'string' },
                timestamp: { type: 'string' },
                uptimeSeconds: { type: 'number' }
              }
            }
          }
        }
      },
      async () => ({
        status: 'UP',
        timestamp: new Date().toISOString(),
        uptimeSeconds: process.uptime()
      })
    );

    // Readiness probe (checks active database connectivity)
    const readyHandler = async (_request: any, reply: any) => {
      try {
        if (deps.dbClient) {
          await deps.dbClient.query('SELECT 1');
        }
        return {
          status: 'READY',
          database: 'CONNECTED',
          timestamp: new Date().toISOString()
        };
      } catch (err: any) {
        reply.status(503);
        return {
          status: 'NOT_READY',
          database: 'DISCONNECTED',

          timestamp: new Date().toISOString()
        };
      }
    };

    app.get(
      '/ready',
      {
        schema: {
          description:
            'Readiness probe asserting database connectivity for load balancers (ALB/K8s)',
          tags: ['Health'],
          security: []
        }
      },
      readyHandler
    );

    app.get(
      '/health/ready',
      {
        schema: {
          description:
            'Readiness probe asserting database connectivity for load balancers (ALB/K8s)',
          tags: ['Health'],
          security: []
        }
      },
      readyHandler
    );

    // List Warehouses
    app.get(
      '/api/v1/warehouses',
      {
        schema: {
          description: 'List all warehouses with current stock levels and coordinates',
          tags: ['Warehouses'],
          response: {
            200: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  coordinates: {
                    type: 'object',
                    properties: {
                      latitude: { type: 'number' },
                      longitude: { type: 'number' }
                    }
                  },
                  stock: { type: 'integer' },
                  updatedAt: { type: 'string' }
                }
              }
            }
          }
        }
      },
      async () => {
        return deps.listWarehousesUseCase.execute();
      }
    );

    const quoteHandler = async (request: any, reply: any) => {
      const validatedInput = QuoteOrderInputSchema.parse(request.body);
      const quote = await deps.quoteOrderUseCase.execute(validatedInput);
      metrics.recordQuote();
      return reply.status(200).send(quote);
    };

    const quoteSchema = {
      response: { 200: quoteResponseSchema, ...errors },
      description:
        'Simulate and verify an order fulfillment quote without placing it or modifying inventory',
      tags: ['Orders'],
      body: {
        type: 'object',
        required: ['quantity', 'customerCoordinates'],
        properties: {
          quantity: {
            type: 'integer',
            minimum: 1,
            maximum: 1000000,
            description: 'Number of SCOS Station P1 Pro devices'
          },
          customerCoordinates: {
            type: 'object',
            required: ['latitude', 'longitude'],
            properties: {
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 }
            }
          }
        }
      }
    };

    app.post('/v1/order-quotes', { schema: quoteSchema }, quoteHandler);

    const submitHandler = async (request: any, reply: any) => {
      const validatedInput = SubmitOrderInputSchema.parse(request.body);
      const idempotencyKey = (request.headers['idempotency-key'] as string) || undefined;
      const salesRepId =
        (request.headers['x-sales-rep-id'] as string) ||
        (request.headers['sales-rep-id'] as string) ||
        undefined;

      const confirmation = await deps.submitOrderUseCase.execute(validatedInput, {
        idempotencyKey,
        salesRepId
      });

      const { replayed, ...order } = confirmation;
      if (replayed) metrics.recordDuplicateIdempotency();
      else metrics.recordOrderSubmitted();
      reply.header('idempotency-replayed', String(replayed));
      return reply.status(replayed ? 200 : 201).send(order);
    };

    const submitSchema = {
      response: {
        200: {
          ...orderSchema,
          description: 'Previously committed order returned for an identical idempotent retry'
        },
        201: { ...orderSchema, description: 'Order committed and inventory deducted' },
        ...errors
      },
      description:
        'Submit a confirmed order, deduct inventory across optimal warehouses atomically, and persist order',
      tags: ['Orders'],
      headers: {
        type: 'object',
        properties: {
          'idempotency-key': {
            type: 'string',
            minLength: 1,
            maxLength: 200,
            pattern: '\\S',
            description: 'Unique idempotency key to prevent double execution on network retries'
          },
          'x-sales-rep-id': {
            type: 'string',
            maxLength: 200,
            description: 'Optional ID of the sales representative submitting the order'
          }
        }
      },
      body: {
        type: 'object',
        required: ['quantity', 'customerCoordinates'],
        properties: {
          quantity: {
            type: 'integer',
            minimum: 1,
            maximum: 1000000,
            description: 'Number of SCOS Station P1 Pro devices'
          },
          customerCoordinates: {
            type: 'object',
            required: ['latitude', 'longitude'],
            properties: {
              latitude: { type: 'number', minimum: -90, maximum: 90 },
              longitude: { type: 'number', minimum: -180, maximum: 180 }
            }
          }
        }
      }
    };

    app.post('/v1/orders', { schema: submitSchema }, submitHandler);

    const getOrderHandler = async (request: any, reply: any) => {
      const { orderNumber } = request.params as { orderNumber: string };
      const order = await deps.getOrderUseCase.execute(orderNumber);
      return reply.status(200).send(order);
    };

    const getOrderSchema = {
      response: { 200: orderSchema, ...errors },
      description: 'Retrieve an existing order and its fulfillment breakdown by order number',
      tags: ['Orders'],
      params: {
        type: 'object',
        required: ['orderNumber'],
        properties: {
          orderNumber: { type: 'string', description: 'Order number, e.g. SC-20260918-XXXX' }
        }
      }
    };

    app.get('/v1/orders/:orderNumber', { schema: getOrderSchema }, getOrderHandler);

    // Prometheus Operational Metrics Endpoint
    app.get(
      '/metrics',
      {
        schema: {
          description: 'Prometheus-formatted operational metrics (counters, gauges, uptime)',
          tags: ['Monitoring']
        }
      },
      async (_request, reply) => {
        const warehouses = await deps.listWarehousesUseCase.execute();
        reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        return metrics.toPrometheusFormat(warehouses as any);
      }
    );

    // Low Stock Alert Endpoint for Operations
    app.get(
      '/api/v1/alerts/stock',
      {
        schema: {
          description:
            'Inspect warehouses approaching critically low inventory levels (threshold <= 50)',
          tags: ['Monitoring']
        }
      },
      async () => {
        const warehouses = await deps.listWarehousesUseCase.execute();
        const alerts = metrics.getLowStockAlerts(warehouses as any, 50);
        return {
          thresholdUnits: 50,
          alertsCount: alerts.length,
          hasLowStockAlerts: alerts.length > 0,
          alerts
        };
      }
    );
  };
}
