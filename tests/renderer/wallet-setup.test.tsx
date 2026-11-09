import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WalletSetup } from '../../src/renderer/src/screens/WalletSetup';
import { useApp } from '../../src/renderer/src/store/app';

/**
 * Smoke-test the first-launch flow: "Create new wallet" reaches the
 * mnemonic-reveal step and blocks on the "I backed it up" checkbox before
 * proceeding to funding status.
 */

const FAKE_ADDRESS = 'sent1yftwk6a4h5fk4xzp3znk6puqj92uxw7jhxwd76';
const FAKE_MNEMONIC = 'tribe solution puppy eager nasty lonely advice gym worth above oblige rocket salmon merit cloth exchange ranch bulk flock quote orient vehicle flush vessel';

beforeEach(() => {
  const api = {
    wallet: {
      create: vi.fn().mockResolvedValue({
        wallet: { address: FAKE_ADDRESS, balanceDVPN: 0, createdAt: new Date().toISOString(), hasMnemonic: true },
        mnemonic: FAKE_MNEMONIC,
      }),
      restore: vi.fn(),
      get: vi.fn(),
      refreshBalance: vi.fn().mockResolvedValue({
        address: FAKE_ADDRESS,
        balanceDVPN: 5,
        createdAt: new Date().toISOString(),
        hasMnemonic: true,
      }),
      send: vi.fn(),
      qrSvg: vi.fn().mockResolvedValue('<svg></svg>'),
    },
  };
  (globalThis as unknown as { window: { api: unknown } }).window.api = api;
  // clipboard is a getter-only prop on the navigator from happy-dom; stub
  // via defineProperty.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn() },
    writable: true,
    configurable: true,
  });

  // reset the store to baseline for each test
  useApp.setState({
    route: { name: 'wallet-setup' },
    wallet: null,
    walletBootstrapped: true,
    toasts: [],
    confirmPrompt: null,
    events: [],
    nodes: [],
    settings: null,
    chainHealth: [],
    liveStatuses: {},
    nodeHistory: {},
    progress: null,
    history: [],
    canGoBack: false,
    online: true,
  });
});

afterEach(() => cleanup());

describe('WalletSetup', () => {
  it('shows the two choice cards on first render', () => {
    render(<WalletSetup />);
    expect(screen.getByText(/Create new wallet/i)).toBeDefined();
    expect(screen.getByText(/Restore existing wallet/i)).toBeDefined();
  });

  it('creates a wallet and requires backup confirmation before continue', async () => {
    const user = userEvent.setup();
    render(<WalletSetup />);

    // The "Create wallet" CTA is one of multiple buttons on screen — find
    // the one whose accessible label matches the current copy.
    const buttons = screen.getAllByRole('button');
    const initBtn = buttons.find((b) =>
      /Create wallet/i.test(b.textContent ?? '') && !/Restore/i.test(b.textContent ?? ''),
    );
    expect(initBtn).toBeDefined();
    await user.click(initBtn!);

    // Mnemonic is revealed as 24 individual word tiles; assert the first
    // word renders. Continue is disabled until the backup checkbox ticks.
    const firstWord = FAKE_MNEMONIC.split(/\s+/)[0];
    const wordEl = await screen.findByText(firstWord);
    expect(wordEl).toBeDefined();

    const continueBtn = screen.getByRole('button', { name: /Continue/i });
    expect(continueBtn.getAttribute('disabled')).not.toBeNull();

    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);

    expect(continueBtn.getAttribute('disabled')).toBeNull();
  });

  // Q0297: Continue opens a 3-word check; a wrong word blocks, the right words finish.
  async function toCheck() {
    const user = userEvent.setup();
    const { container } = render(<WalletSetup />);
    const initBtn = screen.getAllByRole('button').find((b) =>
      /Create wallet/i.test(b.textContent ?? '') && !/Restore/i.test(b.textContent ?? ''),
    );
    await user.click(initBtn!);
    await screen.findByText(FAKE_MNEMONIC.split(/\s+/)[0]);
    await user.click(screen.getByRole('checkbox'));
    await user.click(screen.getByRole('button', { name: /Continue/i }));
    const asks = [...container.querySelectorAll('[data-phrase-ask]')] as HTMLInputElement[];
    return { user, container, asks };
  }

  it('Q0297: a wrong word is rejected and the phrase is not in the DOM during the check', async () => {
    const { user, container, asks } = await toCheck();
    expect(asks.length).toBe(3);
    expect(container.querySelector('[data-phrase-word]')).toBeNull();
    const words = FAKE_MNEMONIC.split(/\s+/);
    for (const a of asks) await user.type(a, words[Number(a.dataset.phraseAsk) - 1]);
    await user.clear(asks[1]);
    await user.type(asks[1], 'zzzz');
    await user.click(container.querySelector('[data-phrase-check-submit]') as HTMLElement);
    expect(container.querySelector('[data-phrase-wrong]')?.getAttribute('data-phrase-wrong')).toBe(asks[1].dataset.phraseAsk);
    expect(screen.queryByText(/Funding status/i)).toBeNull();
  });

  it('Q0297: the right words reach the funded view', async () => {
    const { user, container, asks } = await toCheck();
    const words = FAKE_MNEMONIC.split(/\s+/);
    for (const a of asks) await user.type(a, words[Number(a.dataset.phraseAsk) - 1]);
    await user.click(container.querySelector('[data-phrase-check-submit]') as HTMLElement);
    expect(container.querySelector('[data-phrase-wrong]')).toBeNull();
    expect(await screen.findByText(/Funding status/i)).toBeDefined();
  });

  it('log out while on the funded view falls back to Create / Restore (no blank screen)', async () => {
    const { user, container, asks } = await toCheck();
    const words = FAKE_MNEMONIC.split(/\s+/);
    for (const a of asks) await user.type(a, words[Number(a.dataset.phraseAsk) - 1]);
    await user.click(container.querySelector('[data-phrase-check-submit]') as HTMLElement);
    await screen.findByText(/Funding status/i);
    act(() => useApp.setState({ wallet: null }));
    expect(await screen.findByText(/Create new wallet/i)).toBeDefined();
  });
});
