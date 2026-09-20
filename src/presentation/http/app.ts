import { timingSafeEqual } from 'node:crypto';
import Fastify, { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { createRoutes, RouteDependencies } from './routes.js';

export interface AppOptions {
  logger?: boolean | object;
  apiToken?: string;
}

export async function buildApp(
  deps: RouteDependencies,
  options: AppOptions = {}
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    ajv: {
      customOptions: {
        allErrors: true
      }
    }
  });

  app.addHook('onRequest', async (request, reply) => {
    if (
      !options.apiToken ||
      ['/health', '/ready', '/health/ready'].includes(request.url.split('?')[0])
    )
      return;
    const actual = Buffer.from(request.headers.authorization ?? '');
    const expected = Buffer.from(`Bearer ${options.apiToken}`);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
      return reply
        .code(401)
        .type('application/problem+json')
        .send({
          type: 'about:blank',
          title: 'Unauthorized',
          status: 401,
          detail: 'A valid bearer token is required.'
        });
    }
  });

  // Configure OpenAPI / Swagger
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'ScreenCloud Order Management System (SCOS OMS) API',
        description:
          'Quotes, inventory allocation, and order submission for SCOS Station P1 Pro devices.',
        version: '1.0.0',
        contact: {
          name: 'ScreenCloud Engineering',
          url: 'https://screencloud.com'
        }
      },
      servers: [
        {
          url: '/',
          description: 'Current API server'
        }
      ],
      components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } } },
      ...(options.apiToken ? { security: [{ bearerAuth: [] }] } : {}),
      tags: [
        { name: 'Orders', description: 'Order simulation, quotes, and atomic submission' },
        { name: 'Warehouses', description: 'Real-time warehouse inventory and locations' },
        { name: 'Health', description: 'Service liveness and health diagnostics' }
      ]
    }
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true
    },
    staticCSP: true,
    transformStaticCSP: (header) => header
  });

  // Register application routes
  await app.register(createRoutes(deps));

  return app;
}
