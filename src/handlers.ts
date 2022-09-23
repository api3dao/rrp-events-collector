import 'source-map-support/register';
import path from 'path';
import fs from 'fs';
import { logging, sendOpsGenieHeartbeat } from '@api3/operations-utilities';
import { flushDb, initDb } from './database';
import { Config } from './types';
import { runRrpCollectionTask } from './rrp-collection';

export const getConfig = (): Config => {
  const configPath = path.join(__dirname, '../config/config.json');
  logging.debugLog('Config Path:', configPath, fs.readdirSync(path.join(__dirname, '..')));

  return JSON.parse(fs.readFileSync(configPath).toString('utf-8'));
};

/**
 * Collects events related to the Airnode RRP contract
 *
 * @param _event
 */
export const rrpCollectionHandler = async (_event: any = {}): Promise<any> => {
  logging.log('Starting RRP Collector');
  const startedAt = new Date();
  const config = getConfig();
  const db = await initDb(config);

  try {
    await runRrpCollectionTask(config, db);
  } catch (err) {
    const error = err as Error;
    logging.log(`RRP collector encountered an error: ${error.message}`, 'ERROR', error.stack);
  }

  await flushDb(db);

  await sendOpsGenieHeartbeat('rrp-collector', config.opsGenieConfig);
  const endedAt = new Date();
  console.log(`RRP Collection Handler run delta: ${(endedAt.getTime() - startedAt.getTime()) / 1000}s`);
};
