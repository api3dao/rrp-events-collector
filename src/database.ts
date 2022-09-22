import tls from 'tls';
import { Client } from 'pg';
import { closeOpsGenieAlertWithAlias, sendToOpsGenieLowLevel, logging } from '@api3/operations-utilities';
import { go } from '@api3/promise-utils';
import { Config } from './types';

export interface OverrideDatabaseOptions {
  hostname: string;
  username: string;
  password: string;
  database: string;
  port: string;
  ssl: boolean;
}

export const initDb = async (config: Config, optionalOverrides?: OverrideDatabaseOptions) => {
  if (process.env.POSTGRES_HOST === undefined) {
    return;
  }

  const host = optionalOverrides?.hostname ?? process.env.POSTGRES_HOST ?? '';
  const port = parseInt(optionalOverrides?.port ?? process.env.POSTGRES_PORT ?? '65432');
  const ssl_enabled = optionalOverrides?.ssl || process.env.POSTGRES_SSL;

  const sslDbConnectOperation = async () => {
    logging.debugLog('Connecting to postgres with SSL');
    const socketPromise = ssl_enabled
      ? await new Promise((resolve, reject) => {
          const socket = tls.connect(
            port,
            host,
            {
              servername: host,
              host,
            },
            () => {
              if (socket.authorized) {
                resolve(socket);
              } else {
                reject('TLS Authorisation failure');
              }
            }
          );
        })
      : undefined;

    const db = new Client({
      stream: socketPromise as tls.TLSSocket,
      port,
      user: optionalOverrides?.username ?? process.env.POSTGRES_USER,
      password: optionalOverrides?.password ?? process.env.POSTGRES_PASSWORD,
      host: optionalOverrides?.hostname ?? process.env.POSTGRES_HOST,
      database: optionalOverrides?.database ?? process.env.POSTGRES_DATABASE,
    });

    await db.connect();
    await db.query('select 1;');

    return db;
  };

  const plainDbConnectOperation = async () => {
    logging.debugLog('Connecting to postgres without SSL');
    const db = new Client({
      port,
      user: optionalOverrides?.username ?? process.env.POSTGRES_USER,
      password: optionalOverrides?.password ?? process.env.POSTGRES_PASSWORD,
      host: optionalOverrides?.hostname ?? process.env.POSTGRES_HOST,
      database: optionalOverrides?.database ?? process.env.POSTGRES_DATABASE,
      ssl: false,
    });

    await db.connect();
    await db.query('select 1;');

    return db;
  };

  const dbConnectResult = await go(ssl_enabled ? sslDbConnectOperation : plainDbConnectOperation, {
    attemptTimeoutMs: 5_000,
    retries: 0,
  });
  if (!dbConnectResult.success) {
    const err = dbConnectResult.error;
    await sendToOpsGenieLowLevel(
      {
        message: 'Database connection failed',
        alias: 'database-connection-failed',
        description: err
          ? `Message: ${err.message}
      Stack: 
      ${JSON.stringify(err.stack, null, 2)}`
          : 'Database connection failed unexpectedly.',
        priority: 'P2',
      },
      config.opsGenieConfig
    );
    return undefined;
  }

  await closeOpsGenieAlertWithAlias(`database-connection-failed`, config.opsGenieConfig);

  return dbConnectResult.data;
};

export const flushDb = async (db?: Client) => {
  if (!db) {
    return;
  }

  await db.end();
};
