const config = require('./jest.config');

// eslint-disable-next-line functional/immutable-data
module.exports = {
  ...config,
  name: 'e2e',
  displayName: 'e2e',
  setupFiles: ['<rootDir>/test/setup/init/set-define-property.ts'],
  testMatch: ['**/?(*.)+(feature).[tj]s?(x)'],
};
