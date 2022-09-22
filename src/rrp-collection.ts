import { ethers } from 'ethers';
import { parseAirnodeRrpLog } from '@api3/airnode-node/dist/src/evm/requests/event-logs';
import { EVMEventLog } from '@api3/airnode-node/dist/src/types';
import { Client } from 'pg';
import * as importedDeployments from '@api3/airnode-protocol/dist/deployments/references.json';
import { go } from '@api3/promise-utils';
import { logging } from '@api3/operations-utilities';
import { Config } from './types';

type UniqueEventsWithBlockTimes = Record<string, { events: number; time: number }>;

export const ANU_AIRNODE_ADDRESS = '0x9d3C147cA16DB954873A498e0af5852AB39139f2';

export interface Deployments {
  chainNames: Record<string, string>;
  AccessControlRegistry: Record<string, string>;
  RequesterAuthorizerWithAirnode: Record<string, string>;
  AirnodeRrpV0: Record<string, string>;
}

const deployments = importedDeployments as Deployments;
const { AirnodeRrpV0 } = deployments;

/**
 * Collects request counts on a per-block basis from configured chains and inserts the results into the database
 *
 * @param config the configuration of the RRP events collector
 * @param db the target database
 */
export const runRrpCollectionTask = async (config: Config, db?: Client) => {
  if (!db) {
    console.log('Database not initialized - quitting.');
    process.exit(0);
  }

  // For development: if you need to recreate the tables, uncomment this command
  // await db.query(`DROP TABLE IF EXISTS qrng_requests_per_block; DROP TABLE IF EXISTS qrng_fulfilments_per_block;`);

  // This won't do anything if the table exists
  // This is like a mini database migration
  await db.query(
    `
CREATE TABLE IF NOT EXISTS qrng_requests_per_block (
            "time" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "events" bigint,
            "chain" bigint,
            "block" bigint,
            UNIQUE (chain, block)
);`
  );

  await db.query(
    `
CREATE TABLE IF NOT EXISTS qrng_fulfilments_per_block (
            "time" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "events" bigint,
            "chain" bigint,
            "block" bigint,
            UNIQUE (chain, block)
);`
  );

  // For development: if you just want to empty the existing tables, uncomment this command
  // await db.query(`DELETE FROM qrng_requests_per_block; DELETE FROM qrng_fulfilments_per_block`);
  // await db.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO grafanareader;`);

  await Promise.allSettled(
    Object.entries(config.chains).map(async ([key, value]) => {
      try {
        const chainId = parseInt(key);

        // Get the last block on a per-chain basis
        const maxBlockFromRequests =
          parseInt(
            (await db.query(`SELECT MAX(block) FROM qrng_requests_per_block WHERE chain = $1;`, [chainId.toString()]))
              .rows[0].max ?? 0
          ) + 1;

        const provider = new ethers.providers.StaticJsonRpcProvider(value.rpc, { chainId, name: key });

        const rawBlockResult = await go(() => provider.getBlockNumber(), {
          attemptTimeoutMs: 10_000,
          retries: 5,
        });

        if (!rawBlockResult.success) {
          logging.logTrace(
            'Block number retrieval failure',
            'ERROR',
            JSON.stringify(
              {
                error: rawBlockResult.error,
                rpc_url: value.rpc,
                chainId,
                name: key,
              },
              null,
              2
            )
          );
          return;
        }

        const rawBlock = rawBlockResult.data;

        // The maximum number of blocks to query
        // Public RPCs usually have more severe limitations than, say, Alchemy.
        const maxBlock = 2_000;

        // This seems to be a common restriction of getLogs
        const fromBlock = rawBlock - maxBlockFromRequests > maxBlock ? rawBlock - maxBlock : maxBlockFromRequests;

        const rawLogsResult = await go(
          () =>
            provider.getLogs({
              fromBlock,
              toBlock: 'latest',
              address: AirnodeRrpV0[key],
              topics: [null, ethers.utils.hexZeroPad(ANU_AIRNODE_ADDRESS, 32)],
            }),
          // Timeouts can be quite long for the initial query
          { attemptTimeoutMs: 60_000, retries: 2 }
        );
        if (!rawLogsResult.success) {
          // TODO better error handling
          const err = rawLogsResult.error;
          logging.log('Unable to retrieve block in the RRP events collector', 'ERROR', `${err.message}\n${err.stack}`);
          return;
        }

        const rawLogs = rawLogsResult.data;

        const logsWithBlocks = rawLogs.map((log: any) => ({
          address: log.address,
          blockNumber: log.blockNumber,
          transactionHash: log.transactionHash,
          parsedLog: parseAirnodeRrpLog(log),
        })) as EVMEventLog[];

        const filteredLogsWithBlocksFulfilments = logsWithBlocks.filter(
          (log) => log.parsedLog.eventFragment.name === 'FulfilledRequest'
        );

        const uniqueReducerFunction = (prev: Record<string, number>, curr: any) => {
          const thisValue = prev[curr.blockNumber];
          if (thisValue) {
            return {
              ...prev,
              [curr.blockNumber.toString()]: thisValue + 1,
            };
          }

          return {
            ...prev,
            [curr.blockNumber.toString()]: 1,
          };
        };

        const uniqueFulfilments = filteredLogsWithBlocksFulfilments.reduce(
          uniqueReducerFunction,
          {} as Record<string, number>
        );

        // Filters for ANU's endpoints
        const filteredLogsWithBlocksRequests = logsWithBlocks.filter(
          (log) =>
            log.parsedLog.args[5] === '0xfb6d017bb87991b7495f563db3c8cf59ff87b09781947bb1e417006ad7f55a78' ||
            log.parsedLog.args[5] === '0x27cc2713e7f968e4e86ed274a051a5c8aaee9cca66946f23af6f29ecea9704c3'
        );

        const uniqueRequests = filteredLogsWithBlocksRequests.reduce(
          uniqueReducerFunction,
          {} as Record<string, number>
        );

        const uniqueRequestsWithBlockTimes = Object.fromEntries(
          await Promise.all(
            Object.entries(uniqueRequests).map(async ([key, value]) => {
              const block = await provider.getBlock(parseInt(key));
              return [key, { events: value, time: block.timestamp }];
            })
          )
        ) as UniqueEventsWithBlockTimes;

        // This re-uses timestamps for blocks retrieved for requests
        const uniqueFulfilmentsWithBlockTimes = Object.fromEntries(
          await Promise.all(
            Object.entries(uniqueFulfilments).map(async ([key, value]) => {
              const blockTime =
                uniqueRequestsWithBlockTimes[key]?.time ?? (await provider.getBlock(parseInt(key))).timestamp;
              return [key, { events: value, time: blockTime }];
            })
          )
        ) as UniqueEventsWithBlockTimes;

        await Promise.all([
          sendEventsToDatabase(db, 'fulfilments', chainId, uniqueFulfilmentsWithBlockTimes),
          sendEventsToDatabase(db, 'requests', chainId, uniqueRequestsWithBlockTimes),
        ]);

        return;
      } catch (e) {
        const err = e as Error;
        logging.log('A general error occurred in the RRP events collector', 'ERROR', `${err.message}\n${err.stack}`);

        return;
      }
    })
  );
};

export const sendEventsToDatabase = async (
  db: Client,
  type: 'requests' | 'fulfilments',
  chainId: number,
  eventsWithBlockTimes: UniqueEventsWithBlockTimes
) => {
  const dbClient = db; // await db.connect();

  const promisedDatabaseInserts = await Promise.allSettled(
    Object.entries(eventsWithBlockTimes).map(async ([key, value]) => {
      const blockNumber = parseInt(key);

      console.log([value.time, chainId, blockNumber, value.events]);
      await dbClient.query(
        `INSERT INTO ${type === 'requests' ? 'qrng_requests_per_block' : 'qrng_fulfilments_per_block'}
        ("time", "chain", "block", "events")
        VALUES
        (to_timestamp($1), $2, $3, $4)
        ON CONFLICT DO NOTHING;
        `,
        [value.time, chainId, blockNumber, value.events]
      );
    })
  );

  // We're not worried about rejects due to a constraint violation - because such a rejection occurs when we already have the data we want
  // This can probably be simplified but who has time for boolean logic anyway?
  const rejections = promisedDatabaseInserts.filter((promise) => {
    if (promise.status === 'rejected') {
      if (promise.reason) {
        return !promise.reason.toString().startsWith('duplicate key value violates unique constraint');
      }

      return true;
    }
  });

  if (rejections.length > 0) {
    logging.log(
      'A DB INSERT error occurred in the RRP events collector',
      'ERROR',
      `Refer to the logs for details. Summary: \n ${JSON.stringify(rejections, null, 2)}`
    );

    return;
  }
};
