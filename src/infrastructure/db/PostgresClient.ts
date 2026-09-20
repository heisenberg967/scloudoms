import postgres from 'postgres';
import { migrate } from './migrations.js';

export interface SqlConnection {
  query<T extends Record<string, any> = Record<string, any>>(
    text: string,
    values?: unknown[]
  ): Promise<T[]>;
}

export class PostgresClient implements SqlConnection {
  readonly sql: postgres.Sql;

  constructor(
    config: { connectionString?: string; maxConnections?: number; schema?: string } = {}
  ) {
    const url = config.connectionString ?? process.env.DATABASE_URL;
    if (!url)
      throw new Error(
        'DATABASE_URL is required. Start PostgreSQL with docker compose up -d postgres.'
      );
    if (config.schema && !/^[a-z][a-z0-9_]*$/.test(config.schema))
      throw new Error('Invalid database schema');
    this.sql = postgres(url, {
      max: config.maxConnections ?? 10,
      connect_timeout: 5,
      idle_timeout: 20,
      connection: {
        application_name: 'screencloud-oms',
        statement_timeout: 15000,
        ...(config.schema ? { search_path: config.schema } : {})
      },
      onnotice: () => {}
    });
  }

  async query<T extends Record<string, any> = Record<string, any>>(
    text: string,
    values: unknown[] = []
  ): Promise<T[]> {
    return (await this.sql.unsafe(
      text,
      values as postgres.ParameterOrJSON<never>[]
    )) as unknown as T[];
  }

  async transaction<T>(work: (connection: SqlConnection) => Promise<T>): Promise<T> {
    const result = await this.sql.begin(async (sql) =>
      work({
        query: async <R extends Record<string, any>>(text: string, values: unknown[] = []) =>
          (await sql.unsafe(text, values as postgres.ParameterOrJSON<never>[])) as unknown as R[]
      })
    );
    return result as T;
  }

  async initializeSchema(): Promise<void> {
    await this.transaction(migrate);
  }

  async close(): Promise<void> {
    await this.sql.end({ timeout: 5 });
  }
}
