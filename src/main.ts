import 'source-map-support/register';
import { promises, evm } from '@api3/operations-utilities';
import { rrpCollectionHandler } from './handlers';

export const runAndHandleErrors = (fn: () => Promise<unknown>) => {
  fn()
    .then(() => {
      // defaults to a heartbeat which allows the serverless watcher to determine if the app ran
      evm.exit();
    })
    .catch((e) => {
      console.trace('RRP Collector Error - Parent Scope', e.stack);
    });
};

const main = async () => {
  await promises.settleAndCheckForPromiseRejections([rrpCollectionHandler({})]);
};

runAndHandleErrors(main);
