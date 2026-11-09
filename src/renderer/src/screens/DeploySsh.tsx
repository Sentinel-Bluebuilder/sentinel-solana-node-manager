import { useState } from 'react';
import { PageHeader } from '../components/PageHeader';
import { MIcon } from '../components/MIcon';
import { useApp } from '../store/app';
import { ProtocolTiles } from './DeployLocal';
import type {
  SSHCredentials,
  SSHTestResult,
  VpnServiceType,
} from '../../../shared/types';

export function DeploySsh() {
  const { navigate, pushToast } = useApp();
  const [authMode, setAuthMode] = useState<'key' | 'password'>('key');
  const [form, setForm] = useState<SSHCredentials>({
    host: '',
    port: 22,
    username: 'root',
  });
  const [privateKey, setPrivateKeyRaw] = useState('');
  const [passphrase, setPassphraseRaw] = useState('');
  const [password, setPasswordRaw] = useState('');
  // Any credential/host edit invalidates the last connection test.
  const setPrivateKey = (v: string) => { setPrivateKeyRaw(v); setResult(null); };
  const setPassphrase = (v: string) => { setPassphraseRaw(v); setResult(null); };
  const setPassword = (v: string) => { setPasswordRaw(v); setResult(null); };

  const [moniker, setMoniker] = useState(
    `dvpn-${Math.random().toString(36).slice(2, 6)}`,
  );
  const [service, setService] = useState<VpnServiceType>('wireguard');
  // First port of the node's 5-port block (api + service listeners).
  const [nodePort, setNodePort] = useState(41000);
  const [gigabytePrice, setGigabytePrice] = useState('0.002');
  const [hourlyPrice, setHourlyPrice] = useState('0.001');
  const [leasePrice, setLeasePrice] = useState('0.001');
  const [remoteUrl, setRemoteUrl] = useState('');

  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<SSHTestResult | null>(null);
  const [deploying, setDeploying] = useState(false);

  // The node uses a 5-port block starting here.
  const nodePortValid =
    Number.isInteger(nodePort) && nodePort >= 1024 && nodePort <= 65531;
  const nodePortError = !Number.isInteger(nodePort)
    ? 'Port must be a whole number.'
    : nodePort < 1024 || nodePort > 65531
      ? 'Port must be between 1024 and 65531 (the node uses five consecutive ports).'
      : null;

  // The program rejects a zero price; there is no price cap.
  const pricesValid = Number(gigabytePrice) > 0 && Number(hourlyPrice) > 0 && (Number(leasePrice) || Number(hourlyPrice)) > 0;

  const creds = (): SSHCredentials => ({
    ...form,
    port: Number(form.port) || 22,
    privateKey: authMode === 'key' ? privateKey : undefined,
    passphrase: authMode === 'key' && passphrase ? passphrase : undefined,
    password: authMode === 'password' ? password : undefined,
  });

  const runTest = async () => {
    setResult(null);
    setTesting(true);
    try {
      const r = await window.api.ssh.test(creds());
      setResult(r);
      if (r.ok)
        pushToast({
          title: 'SSH works',
          body: `${r.latencyMs}ms · ${r.osInfo}`,
          tone: 'success',
        });
      else pushToast({ title: 'SSH failed', body: r.message, tone: 'error' });
    } catch (e) {
      setResult({ ok: false, message: (e as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const startDeploy = async () => {
    setDeploying(true);
    try {
      const { jobId } = await window.api.deploy.start({
        target: 'remote',
        moniker: moniker.trim(),
        serviceType: service,
        port: nodePort,
        gigabytePriceDVPN: Number(gigabytePrice) || 0,
        hourlyPriceDVPN: Number(hourlyPrice) || 0,
        leaseHourlyPriceDVPN: Number(leasePrice) || Number(hourlyPrice) || 0,
        remoteUrl:
          remoteUrl
            .trim()
            .replace(/^[a-z]+:\/\//i, '')
            .replace(/\/+$/, '') || undefined,
        ssh: creds(),
      });
      navigate({ name: 'progress', jobId, moniker: moniker.trim(), origin: 'ssh' });
    } catch (e) {
      pushToast({
        title: 'Could not start deploy',
        body: (e as Error).message,
        tone: 'error',
      });
    } finally {
      setDeploying(false);
    }
  };

  const ready =
    form.host.trim() &&
    form.username.trim() &&
    moniker.trim().length >= 3 &&
    nodePortValid &&
    pricesValid &&
    (authMode === 'key' ? privateKey.trim() : password.length > 0);

  return (
    <div className="flex flex-col h-full min-h-0 gap-3">
      <PageHeader
        title="Deploy SSH"
        subtitle="Connect a VPS via SSH. Ubuntu / Debian supported out of the box."
        right={
          <div className="flex items-center gap-1 p-0.5 rounded-md" style={{ background: 'var(--bg-input)', border: '1px solid var(--border)' }}>
            <button
              className="btn btn-primary btn-sm"
              style={{ pointerEvents: 'none' }}
              title="Single host"
            >
              <MIcon name="dns" size={14} /> Single host
            </button>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => navigate({ name: 'deploy-ssh-batch' })}
              title="Deploy to many hosts in one go"
            >
              <MIcon name="grid_view" size={14} /> Batch
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-12 gap-3">
        <div className="card col-span-12 lg:col-span-8 flex flex-col overflow-hidden">
          <div className="card-header">
            <div className="card-title flex items-center gap-2">
              <MIcon name="security" size={14} />
              SSH connection
            </div>
          </div>
          <div className="card-body flex flex-col gap-2">
            <div className="grid grid-cols-12 gap-2.5">
              <div className="col-span-7">
                <div className="field-label">Target host</div>
                <input
                  value={form.host}
                  onChange={(e) => { setForm({ ...form, host: e.target.value }); setResult(null); }}
                  placeholder="203.0.113.5 or node.example.com"
                  className="field-input mono-inline"
                />
              </div>
              <div className="col-span-2">
                <div className="field-label">SSH port</div>
                <input
                  value={form.port}
                  onChange={(e) => { setForm({ ...form, port: Number(e.target.value) || 22 }); setResult(null); }}
                  type="number"
                  className="field-input"
                />
              </div>
              <div className="col-span-3">
                <div className="field-label">Username</div>
                <input
                  value={form.username}
                  onChange={(e) => { setForm({ ...form, username: e.target.value }); setResult(null); }}
                  placeholder="root"
                  className="field-input mono-inline"
                />
              </div>
            </div>

            <div>
              <div className="flex gap-2 mb-1.5">
                <button
                  className={`btn flex-1 ${authMode === 'key' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAuthMode('key')}
                >
                  <MIcon name="key" size={14} /> SSH key
                </button>
                <button
                  className={`btn flex-1 ${authMode === 'password' ? 'btn-primary' : 'btn-secondary'}`}
                  onClick={() => setAuthMode('password')}
                >
                  <MIcon name="password" size={14} /> Password
                </button>
              </div>

              {authMode === 'key' ? (
                <div className="flex flex-col gap-1.5">
                  <textarea
                    rows={2}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    value={privateKey}
                    onChange={(e) => setPrivateKey(e.target.value)}
                    className="field-input mono-inline text-xs"
                  />
                  <input
                    value={passphrase}
                    onChange={(e) => setPassphrase(e.target.value)}
                    type="password"
                    placeholder="Passphrase (optional)"
                    className="field-input"
                  />
                </div>
              ) : (
                <input
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  type="password"
                  placeholder="SSH password"
                  className="field-input"
                />
              )}
            </div>

            <div>
              <div className="grid grid-cols-12 gap-2">
                <div className="col-span-5">
                  <div className="field-label">Moniker</div>
                  <input
                    value={moniker}
                    onChange={(e) => setMoniker(e.target.value)}
                    className="field-input mono-inline"
                  />
                </div>
                <div className="col-span-2">
                  <div className="field-label">Port</div>
                  <input
                    value={nodePort}
                    onChange={(e) => setNodePort(Number(e.target.value))}
                    type="number"
                    className="field-input"
                    aria-invalid={!nodePortValid}
                  />
                </div>
                <div className="col-span-5">
                  <div className="field-label">
                    Public URL{' '}
                    <span style={{ color: 'var(--text-dim)' }}>(optional)</span>
                  </div>
                  <input
                    value={remoteUrl}
                    onChange={(e) => setRemoteUrl(e.target.value)}
                    placeholder={`${form.host || 'host'}:${nodePort}`}
                    className="field-input mono-inline"
                  />
                </div>
                {nodePortError && (
                  <div
                    className="col-span-12 text-[11px] -mt-1"
                    style={{ color: 'var(--red)' }}
                  >
                    {nodePortError}
                  </div>
                )}
                <div className="col-span-12">
                  <div className="field-label">Protocol</div>
                  <ProtocolTiles value={service} onChange={setService} />
                </div>
                <div className="col-span-4">
                  <div className="field-label">tDVPN / GB</div>
                  <input
                    value={gigabytePrice}
                    onChange={(e) => setGigabytePrice(e.target.value)}
                    type="number"
                    step="0.0001"
                    min="0.000001"
                    className="field-input"
                    aria-invalid={!(Number(gigabytePrice) > 0)}
                  />
                </div>
                <div className="col-span-4">
                  <div className="field-label">tDVPN / hour</div>
                  <input
                    value={hourlyPrice}
                    onChange={(e) => setHourlyPrice(e.target.value)}
                    type="number"
                    step="0.0001"
                    min="0.000001"
                    className="field-input"
                    aria-invalid={!(Number(hourlyPrice) > 0)}
                  />
                </div>
                <div className="col-span-4">
                  <div className="field-label">tDVPN / hour (lease)</div>
                  <input
                    value={leasePrice}
                    onChange={(e) => setLeasePrice(e.target.value)}
                    type="number"
                    step="0.0001"
                    min="0.000001"
                    className="field-input"
                  />
                </div>
                {!pricesValid && (
                  <div className="col-span-12">
                    <div className="callout callout-warn text-xs flex items-start gap-2">
                      <MIcon name="warning" size={14} />
                      <span>All three prices must be greater than 0 — the program rejects a zero price.</span>
                    </div>
                  </div>
                )}
              </div>
            </div>

            {result && (
              <div
                className={`callout ${result.ok ? 'callout-success' : 'callout-danger'}`}
              >
                {result.ok ? (
                  <>
                    <span className="font-semibold">Connected.</span>{' '}
                    {result.latencyMs}ms · {result.osInfo}
                  </>
                ) : (
                  <>
                    <span className="font-semibold">Connection failed.</span>{' '}
                    {result.message}
                  </>
                )}
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-1">
              <button
                className="btn btn-secondary"
                onClick={runTest}
                disabled={!ready || testing}
              >
                {testing ? 'Testing…' : 'Test connection'}
              </button>
              <button
                className="btn btn-primary"
                onClick={startDeploy}
                disabled={!ready || deploying || !result?.ok}
                title={!result?.ok ? 'Test the SSH connection first' : undefined}
              >
                {deploying ? 'Starting…' : 'Deploy'}
                <MIcon name="arrow_forward" size={14} />
              </button>
            </div>
          </div>
        </div>

        <div className="col-span-12 lg:col-span-4 flex flex-col min-h-0 gap-3 overflow-auto">
          <div className="card flex flex-col overflow-hidden">
            <div className="card-header">
              <div className="card-title">What happens next</div>
            </div>
            <div className="card-body flex flex-col gap-1.5">
              <Step index={1} label="SSH probe; install Docker if missing" />
              <Step index={2} label="Build the dvpnd node image on the host (first time ≈ 5 min)" />
              <Step index={3} label="Fund the node key: 0.05 SOL + 1 tDVPN bond" />
              <Step index={4} label="dvpnd init; node key + configs written over SFTP (0600)" />
              <Step index={5} label="open_node on Solana devnet, signed by the node key" />
              <Step index={6} label="docker run --restart=unless-stopped; wait until listed" />
              <div
                className="mt-2 pt-2 text-[11px] leading-relaxed flex items-start gap-2"
                style={{
                  borderTop: '1px solid var(--border)',
                  color: 'var(--text-dim)',
                }}
              >
                <MIcon name="lock" size={12} style={{ marginTop: 2, color: 'var(--accent)' }} />
                SSH credentials live only in memory (after an app restart, use Reconnect on the
                node page). The node key is generated here, backed up encrypted with the OS
                keychain, and written to the host over SFTP with mode 0600 — it is the node's
                on-chain owner, so the host must be one you trust.
              </div>
            </div>
          </div>

          <CurrentRules />
        </div>
      </div>
    </div>
  );
}

function CurrentRules() {
  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title">Current rules</div>
      </div>
      <div
        className="card-body flex flex-col gap-2 text-xs"
        style={{ color: 'var(--text-muted)' }}
      >
        <Bullet>Bond: 1 tDVPN per node, returned 1 hour after removal.</Bullet>
        <Bullet>Open the node's five ports (TCP+UDP) in the provider firewall / security group — clients dial them directly.</Bullet>
        <Bullet>Ubuntu / Debian with root or passwordless sudo; the app installs Docker when missing.</Bullet>
        <Bullet>Listing lasts 24 h; the daemon re-lists itself every hour while it runs.</Bullet>
        <Bullet>Three positive prices in tDVPN; the program has no price cap.</Bullet>
      </div>
    </div>
  );
}

function Bullet({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <MIcon
        name="check_circle"
        size={14}
        style={{ marginTop: 2, color: 'var(--green)' }}
      />
      <span>{children}</span>
    </div>
  );
}

function Step({ index, label }: { index: number; label: string }) {
  return (
    <div className="flex items-start gap-2">
      <div
        className="h-5 w-5 rounded-full text-[10px] grid place-items-center flex-shrink-0 font-semibold"
        style={{
          background: 'color-mix(in srgb, var(--accent) 20%, transparent)',
          color: 'var(--accent)',
        }}
      >
        {index}
      </div>
      <div className="text-xs" style={{ color: 'var(--text-muted)' }}>
        {label}
      </div>
    </div>
  );
}
