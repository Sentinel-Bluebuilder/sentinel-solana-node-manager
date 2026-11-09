import { useEffect } from 'react';
import { useApp } from './store/app';
import { Layout } from './components/Layout';
import { WalletSetup } from './screens/WalletSetup';
import { Overview } from './screens/Overview';
import { Nodes } from './screens/Nodes';
import { NodeDetails } from './screens/NodeDetails';
import { DeployLocal } from './screens/DeployLocal';
import { DeploySsh } from './screens/DeploySsh';
import { DeploySshBatch } from './screens/DeploySshBatch';
import { Progress } from './screens/Progress';
import { Wallet } from './screens/Wallet';
import { Settings } from './screens/Settings';
import { Help } from './screens/Help';
import { ManageDocker } from './screens/ManageDocker';
import { CLI } from './screens/CLI';
import { Activity } from './screens/Activity';
import { System } from './screens/System';
import { OnChainSpecs } from './screens/OnChainSpecs';

export default function App() {
  const { route, bootstrap, walletBootstrapped, bootError } = useApp();

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (bootError) {
    return (
      <div className="h-full w-full grid place-items-center p-6" style={{ background: 'var(--bg)' }}>
        <div className="max-w-lg w-full card">
          <div className="card-header">
            <div className="card-title" style={{ color: 'var(--red)' }}>
              Could not start the manager
            </div>
          </div>
          <div className="card-body flex flex-col gap-3">
            <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
              The main process couldn't respond on startup. Your node, if it's already running in
              Docker, keeps earning. Reloading the window usually fixes this.
            </div>
            <pre
              className="text-[11px] mono-inline p-2 overflow-auto max-h-40"
              style={{
                background: 'var(--bg-input)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius-md)',
                color: 'var(--text)',
              }}
            >
              {bootError}
            </pre>
            <button className="btn btn-primary w-full" onClick={() => window.location.reload()}>
              Reload window
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!walletBootstrapped) {
    return (
      <div className="h-full grid place-items-center text-text-muted text-sm">
        Initializing…
      </div>
    );
  }

  return (
    <Layout>
      {route.name === 'wallet-setup' && <WalletSetup />}
      {route.name === 'overview' && <Overview />}
      {route.name === 'nodes' && <Nodes />}
      {route.name === 'node-details' && <NodeDetails id={route.id} />}
      {route.name === 'deploy-local' && <DeployLocal />}
      {route.name === 'deploy-ssh' && <DeploySsh />}
      {route.name === 'deploy-ssh-batch' && <DeploySshBatch />}
      {route.name === 'progress' && (
        <Progress jobId={route.jobId} moniker={route.moniker} origin={route.origin} />
      )}
      {route.name === 'wallet' && <Wallet />}
      {route.name === 'settings' && <Settings />}
      {route.name === 'manage-docker' && <ManageDocker />}
      {route.name === 'cli' && <CLI />}
      {route.name === 'activity' && <Activity />}
      {route.name === 'on-chain-specs' && <OnChainSpecs />}
      {route.name === 'system' && <System />}
      {route.name === 'help' && <Help />}
    </Layout>
  );
}
