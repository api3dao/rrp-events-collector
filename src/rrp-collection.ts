import { ethers } from 'ethers';
import { Client } from 'pg';
import * as importedDeployments from '@api3/airnode-protocol/dist/deployments/references.json';
import { AirnodeRrpV0Factory } from '@api3/airnode-protocol';
import { go } from '@api3/promise-utils';
import {
  logging,
  TelemetryChainConfig,
  sendToOpsGenieLowLevel,
  closeOpsGenieAlertWithAlias,
  evm,
} from '@api3/operations-utilities';
import { Config } from './types';

export type EventData = ethers.providers.Log & { parsedLog: ethers.utils.LogDescription };

export interface TransactionData {
  gasUsed: ethers.BigNumber;
  effectiveGasPrice: ethers.BigNumber;
  type: number;
  from: string;
}

interface Event {
  time: number;
  chainId: number;
  blockNumber: number;
  transactionHash: string;
  logIndex: number;
  transactionData: TransactionData;
  eventName: string;
  eventData: EventData;
}

type CompoundTransactionData = Omit<ethers.providers.TransactionResponse, 'wait' | 'confirmations'> &
  ethers.providers.TransactionReceipt;

interface CompoundTransaction {
  time: number;
  chainId: number;
  blockNumber: number;
  transactionHash: string;
  transactionData: CompoundTransactionData;
}

export interface Deployments {
  chainNames: Record<string, string>;
  AccessControlRegistry: Record<string, string>;
  RequesterAuthorizerWithAirnode: Record<string, string>;
  AirnodeRrpV0: Record<string, string>;
}

const deployments = importedDeployments as Deployments;
const { AirnodeRrpV0 } = deployments;

export function parseAirnodeRrpLog(log: ethers.providers.Log) {
  const airnodeRrpInterface = new ethers.utils.Interface(AirnodeRrpV0Factory.abi);
  const parsedLog = airnodeRrpInterface.parseLog(log);
  return parsedLog;
}

/**
 * Collects request counts on a per-block basis from configured chains and inserts the results into the database
 *
 * @param config the configuration of the RRP events collector
 * @param db the target database
 */
export const runRrpCollectionTask = async (config: Config, db?: Client) => {
  // Get chain configs based on deployments
  const chainConfig = Object.keys(deployments.chainNames).reduce(
    (acc: Record<string, TelemetryChainConfig>, chainId) => {
      if (config.chains[chainId]) return { ...acc, [chainId]: config.chains[chainId] };
      return acc;
    },
    {}
  );

  if (!db) {
    console.log('Database not initialized - quitting.');
    process.exit(0);
  }

  // For development: if you need to recreate the tables, uncomment this command
  // await db.query(`DROP TABLE IF EXISTS rrp_events; DROP TABLE IF EXISTS rrp_transactions; DROP TABLE IF EXISTS rrp_last_block_per_chain;`);

  // This won't do anything if the table exists
  // This is like a mini database migration
  await db.query(
    `
  CREATE TABLE IF NOT EXISTS rrp_events (
              "time" TIMESTAMPTZ NOT NULL,
              "chain" bigint,
              "block" bigint,
              "transaction_hash" TEXT,
              "log_index" bigint,
              "event_name" TEXT,
              "transaction_data" JSONB,
              "event_data" JSONB,
              PRIMARY KEY(transaction_hash, log_index)
  );
  CREATE INDEX IF NOT EXISTS rrp_events_event_name_idx ON rrp_events (event_name);
  CREATE INDEX IF NOT EXISTS rrp_events_time_idx ON rrp_events (time);`
  );

  await db.query(
    `
  CREATE TABLE IF NOT EXISTS rrp_transactions (
              "time" TIMESTAMPTZ NOT NULL,
              "chain" bigint,
              "block" bigint,
              "transaction_hash" TEXT PRIMARY KEY,
              "transaction_data" JSONB
  );
  CREATE INDEX IF NOT EXISTS rrp_transactions_time_idx ON rrp_transactions (time);`
  );

  // This table is used to keep track of the last queried block from which the next run should start. This ensures that the collector doesn't get stuck if there is a period longer than the defined maxBlock during which no events are found.
  await db.query(
    `
  CREATE TABLE IF NOT EXISTS rrp_last_block_per_chain (
              "time" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              "chain" bigint,
              "block" bigint,
              UNIQUE (chain, block)
  );`
  );

  // For development: if you just want to empty the existing tables, uncomment this command
  // await db.query(`DELETE FROM rrp_events; DELETE FROM rrp_transactions; DELETE FROM rrp_last_block_per_chain;`);
  // await db.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO grafanareader;`);

  await Promise.allSettled(
    Object.entries(chainConfig).map(async ([key, value]) => {
      try {
        const chainId = parseInt(key);

        // Get the last queried block on a per-chain basis
        const lastQueriedBlock = parseInt(
          (await db.query(`SELECT block FROM rrp_last_block_per_chain WHERE chain = $1;`, [chainId.toString()])).rows[0]
            ?.block ?? 1
        );

        const provider = new ethers.providers.StaticJsonRpcProvider(value.rpc, { chainId, name: key });

        const blockResult = await go(() => provider.getBlockNumber(), {
          attemptTimeoutMs: 10_000,
          retries: 3,
        });
        if (!blockResult.success) {
          logging.logTrace('Failed to get block number', 'ERROR', blockResult.error);
          return;
        }

        const rawBlock = blockResult.data;

        // The maximum number of blocks to query
        // Public RPCs usually have more severe limitations than, say, Alchemy.
        const maxBlock = 2_000;
        const fromBlock = lastQueriedBlock + 1;
        const toBlock = rawBlock - fromBlock > maxBlock ? fromBlock + maxBlock : rawBlock;

        const getLogsResult = await go(
          () =>
            provider.getLogs({
              fromBlock,
              toBlock,
              address: AirnodeRrpV0[key],
            }),
          // Timeouts can be quite long for the initial query
          { attemptTimeoutMs: 60_000, retries: 2 }
        );
        if (!getLogsResult.success) {
          const { error } = getLogsResult;

          await sendToOpsGenieLowLevel(
            {
              priority: 'P3',
              alias: `block-retrieval-rrp-collector-error`,
              message: `Unable to retrieve block in the rrp events collector on ${evm.resolveChainName(
                chainId.toString()
              )}`,
              description: `${error.message}\n${error.stack}`,
            },
            config.opsGenieConfig
          );

          return;
        }
        await closeOpsGenieAlertWithAlias(`block-retrieval-rrp-collector-error`, config.opsGenieConfig);

        const logsWithBlocks: Omit<Event, 'transactionData' | 'time'>[] = getLogsResult.data.map(
          (log: ethers.providers.Log) => {
            const parsedLog = parseAirnodeRrpLog(log);
            return {
              chainId,
              blockNumber: log.blockNumber,
              transactionHash: log.transactionHash,
              logIndex: log.logIndex,
              eventName: parsedLog.name,
              eventData: { ...log, parsedLog },
            };
          }
        );

        // Collect full transaction details (i.e. ethers transactionReceipt and transactionResponse)
        // for each RRP event
        const compoundTransactions: CompoundTransaction[] = [];

        const promisedRrpEvents = await Promise.allSettled(
          logsWithBlocks.map(async (logWithBlock) => {
            // Fetch both block and transaction data from the provider to ensure
            // all required data for the current log is retrieved.
            // Throw an error if fetching either fails even after all retries.
            const logsWithBlocksResult = await go(() => provider.getBlockWithTransactions(logWithBlock.blockNumber), {
              retries: 3,
              attemptTimeoutMs: 20_000,
            });

            if (!logsWithBlocksResult.success) {
              console.trace(logsWithBlocksResult.error);
              throw new Error(
                `Unable to get block (${logWithBlock.blockNumber}/${
                  logWithBlock.transactionHash
                }) in the rrp events collector on ${evm.resolveChainName(chainId.toString())}`
              );
            }

            const block = logsWithBlocksResult.data;
            if (!block) {
              // TODO improve error message
              console.trace('Empty block');
              return;
            }

            const transactionReceiptResult = await go(
              () => provider.getTransactionReceipt(logWithBlock.transactionHash),
              {
                retries: 3,
                attemptTimeoutMs: 20_000,
              }
            );

            if (!transactionReceiptResult.success) {
              console.trace(transactionReceiptResult.error);
              throw new Error(
                `Unable to get transaction (${logWithBlock.blockNumber}/${
                  logWithBlock.transactionHash
                }) in the rrp events collector on ${evm.resolveChainName(chainId.toString())}`
              );
            }

            const transactionReceipt = transactionReceiptResult.data;

            const transaction = block.transactions.find(
              (tx: ethers.providers.TransactionResponse) => tx.hash === logWithBlock.transactionHash
            );

            if (!transaction) {
              // This should never happen
              console.trace('Unable to find event log transaction match among the block transactions');
              return;
            }

            const compoundTransaction = {
              time: block.timestamp,
              chainId: logWithBlock.chainId,
              blockNumber: logWithBlock.blockNumber,
              transactionHash: logWithBlock.transactionHash,
              transactionData: { ...transaction, ...transactionReceipt },
            };
            compoundTransactions.push(compoundTransaction);

            const { gasUsed, effectiveGasPrice, type, from } = transactionReceipt;

            return {
              ...logWithBlock,
              time: block.timestamp,
              // At least RSK and BSC do not have effectiveGasPrice in the transactionReceipt so use transaction gasPrice instead
              transactionData: {
                gasUsed,
                effectiveGasPrice: effectiveGasPrice || transaction.gasPrice,
                type,
                from,
              },
            };
          })
        );
        const isFulfilled = <T>(input: PromiseSettledResult<T>): input is PromiseFulfilledResult<T> =>
          input.status === 'fulfilled';

        const rrpEvents = promisedRrpEvents.filter(isFulfilled).map((promise) => promise.value as Event);
        console.log('rrpEvents', rrpEvents);

        await Promise.all([
          sendEventsToDatabase(db, 'events', rrpEvents, config),
          sendEventsToDatabase(db, 'transactions', compoundTransactions, config),
        ]);

        // Save the last queried block number after succesfully inserting the event data
        await db.query(
          `
          UPDATE rrp_last_block_per_chain
          SET time = NOW(),
              block = $1
          WHERE chain = $2;`,
          [toBlock, chainId.toString()]
        );

        await closeOpsGenieAlertWithAlias(`general-rrp-collector-error`, config.opsGenieConfig);
        return;
      } catch (e) {
        const err = e as Error;
        console.error(err.message, err.stack);

        await sendToOpsGenieLowLevel(
          {
            priority: 'P3',
            alias: `general-rrp-collector-error-${ethers.utils.keccak256(Buffer.from(err.name))}`,
            message: 'A general error occurred in the rrp events collector',
            description: `${err.message}\n${err.stack}`,
          },
          config.opsGenieConfig
        );

        return;
      }
    })
  );
};

export const sendEventsToDatabase = async (
  db: Client,
  type: 'events' | 'transactions',
  data: Event[] | CompoundTransaction[],
  config: Config
) => {
  const dbClient = db;

  const rejections: string[] = [];

  for (let i = 0; i < data.length; i++) {
    const item = data[i];

    if (type === 'events') {
      const { time, chainId, blockNumber, transactionHash, logIndex, eventName, transactionData, eventData } =
        item as Event;

      console.log([time, chainId, blockNumber, transactionHash, logIndex, eventName, transactionData, eventData]);
      await dbClient
        .query(
          `INSERT INTO rrp_events
        ("time", "chain", "block", "transaction_hash", "log_index", "event_name", "transaction_data", "event_data")
        VALUES
        (to_timestamp($1), $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT DO NOTHING;
        `,
          [time, chainId, blockNumber, transactionHash, logIndex, eventName, transactionData, eventData]
        )
        .catch((e) => rejections.push(JSON.stringify(e)));
    }

    if (type === 'transactions') {
      const { time, chainId, blockNumber, transactionHash, transactionData } = item as CompoundTransaction;

      console.log([time, chainId, blockNumber, transactionHash, transactionData]);
      await dbClient
        .query(
          `INSERT INTO rrp_transactions
        ("time", "chain", "block", "transaction_hash", "transaction_data")
        VALUES
        (to_timestamp($1), $2, $3, $4, $5)
        ON CONFLICT DO NOTHING;
        `,
          [time, chainId, blockNumber, transactionHash, transactionData]
        )
        .catch((e) => rejections.push(JSON.stringify(e)));
    }
  }

  if (rejections.length > 0) {
    console.error('Something went wrong, rolling back...');
    console.error(rejections);
    await sendToOpsGenieLowLevel(
      {
        priority: 'P3',
        alias: `rejection-rrp-collector-error`,
        message: 'A DB INSERT error occurred in the rrp events collector',
        description: `Refer to the logs for details. Summary: \n ${JSON.stringify(rejections, null, 2)}`,
      },
      config.opsGenieConfig
    );

    return;
  }
  await closeOpsGenieAlertWithAlias(`rejection-rrp-collector-error`, config.opsGenieConfig);
};
