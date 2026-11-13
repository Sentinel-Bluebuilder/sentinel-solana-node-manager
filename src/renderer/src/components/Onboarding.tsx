import { useState } from 'react';
import { useApp } from '../store/app';
import { MIcon } from './MIcon';

/**
 * First-run onboarding overlay. 4 slides. Can be dismissed at any point.
 * Persisted via `settings.seenOnboarding`.
 */
export function Onboarding() {
  const { settings, saveSettings } = useApp();
  const [slide, setSlide] = useState(0);

  if (!settings || settings.seenOnboarding) return null;

  const done = async () => {
    await saveSettings({ seenOnboarding: true });
  };

  const slides = [
    {
      icon: 'vpn_key',
      title: 'Welcome to Sentinel Node Manager',
      body: 'Deploy and operate decentralized VPN nodes on the Sentinel network. Earn tDVPN for the bandwidth you serve, with all settlement happening on chain.',
    },
    {
      icon: 'dns',
      title: 'Run a node, locally or in the cloud',
      body: 'We run the Sentinel dVPN daemon (dvpnd) in a Docker container on this machine or any SSH-reachable VPS, open the node on Solana devnet, and handle keys, config and restarts.',
    },
    {
      icon: 'account_balance_wallet',
      title: 'One wallet, many nodes',
      body: 'Your in-app wallet holds SOL (for fees and node rent) and tDVPN (for node bonds and the revenue you withdraw). Each node owns its own key, and you can withdraw its revenue to your app wallet in one click.',
    },
    {
      icon: 'savings',
      title: 'Fund your wallet first: 1 tDVPN + 0.06 SOL per node',
      body: 'Each node locks a 1 tDVPN bond (returned when you remove it) and needs 0.05 SOL on its key for rent and fees, plus about 0.01 SOL for the fees your wallet pays. The Wallet page shows your address and a QR code; send devnet SOL and tDVPN there from any Solana wallet.',
    },
  ] as const;

  const s = slides[slide];

  return (
    <div className="fixed inset-0 z-40 grid place-items-center bg-bg/90 backdrop-blur-md no-drag">
      <div className="card-elev w-[520px] max-w-[92vw] p-8">
        <div className="flex items-center gap-3">
          <div className="h-12 w-12 rounded-xl bg-accent/15 border border-accent/30 grid place-items-center text-accent">
            <MIcon name={s.icon} size={26} />
          </div>
          <div className="text-xs uppercase tracking-wider text-text-dim">
            Step {slide + 1} of {slides.length}
          </div>
        </div>

        <h2 className="mt-5 text-2xl font-semibold text-text">{s.title}</h2>
        <p className="mt-2 text-sm text-text-muted leading-relaxed">{s.body}</p>

        <div className="mt-8 flex items-center justify-between">
          <div className="flex gap-1.5">
            {slides.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all ${
                  i === slide ? 'bg-accent w-6' : 'bg-border w-1.5'
                }`}
              />
            ))}
          </div>
          <div className="flex gap-2">
            <button className="btn-ghost" onClick={done}>
              Skip
            </button>
            {slide < slides.length - 1 ? (
              <button className="btn-primary" onClick={() => setSlide(slide + 1)}>
                Next
                <MIcon name="arrow_forward" size={14} />
              </button>
            ) : (
              <button className="btn-primary" onClick={done}>
                Get started
                <MIcon name="check" size={14} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
