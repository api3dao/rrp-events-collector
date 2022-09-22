const config = require('./jest.config');

// eslint-disable-next-line functional/immutable-data
module.exports = {
  ...config,
  displayName: 'unit',
  name: 'unit',
  setupFiles: ['<rootDir>/test/setup/init/set-define-property.ts'],
  testMatch: ['**/?(*.)+(spec|test).[tj]s?(x)'],
};
