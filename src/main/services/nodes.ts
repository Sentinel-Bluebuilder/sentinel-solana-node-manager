import * as manager from './node-manager';
import { testNode } from './node-test';
import type { DeployedNode, MetricsSample, MetricsWindow, NodeLiveStatus, VpnServiceType } from '../../shared/types';

/**
 * Thin IPC-layer facade over node-manager.ts. Keeps the IPC surface stable
 * even as the manager internals evolve.
 */

export const listNodes = () => manager.listNodes();
export const getNode = (id: string) => manager.getNode(id);
export const restartNode = (id: string) => manager.restartNode(id);
export const stopNode = (id: string) => manager.stopNode(id);
export const startNode = (id: string) => manager.startNode(id);
/** Starts the resumable removal (redeem → stop → delist → close → unbond → withdraw bond → sweep). */
export const removeNode = (id: string) => manager.beginRemoval(id);
export const recentLogs = (id: string) => manager.recentLogs(id);
export const nodeStatus = (id: string) => manager.liveStatus(id);
export const nodeHistory = (id: string, window: MetricsWindow): MetricsSample[] => manager.historyFor(id, window);
export const withdrawFromNode = (id: string, to: string, amount?: number) => manager.withdrawFromNode(id, to, amount);
export const reapStuckNow = () => manager.reapStuckNow();
export const updateNodePricing = (
  id: string,
  gigabytePriceDVPN: number,
  hourlyPriceDVPN: number,
  opts: { leaseHourlyPriceDVPN?: number } = {},
) => manager.updateNodePricing(id, gigabytePriceDVPN, hourlyPriceDVPN, opts);
export const setNodeProtocol = (id: string, serviceType: VpnServiceType) => manager.setNodeProtocol(id, serviceType);
export const setNodeHandshakeDns = (id: string, enabled: boolean) => manager.setNodeHandshakeDns(id, enabled);
export const useChainHost = (creds: import('../../shared/types').SSHCredentials | null) => manager.useChainHost(creds);
export const chainHostLabel = () => manager.chainHostLabel();
export const redeemNow = (id: string) => manager.redeemNow(id);
export const relistNow = (id: string) => manager.relistNow(id);
export const withdrawBondNow = (id: string) => manager.withdrawBondNow(id);
export const retryRemovalNow = (id: string) => manager.retryRemovalNow(id);
export const forgetServerNow = (id: string) => manager.forgetServerNow(id);
export const testNodeSession = (id: string, opts: { clientOn?: 'host' | 'here'; hnsProbe?: boolean } = {}) => testNode(id, opts);

export type { DeployedNode, NodeLiveStatus };
