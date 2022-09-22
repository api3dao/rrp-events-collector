import { OpsGenieConfig, TelemetryChainConfig } from '@api3/operations-utilities';

export interface Config {
  chains: Record<string, TelemetryChainConfig>;
  opsGenieConfig: OpsGenieConfig;
}
