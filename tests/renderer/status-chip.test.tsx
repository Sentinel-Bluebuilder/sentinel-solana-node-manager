import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { StatusChip } from '../../src/renderer/src/screens/Nodes';

// Each case renders its own chip; without this they pile up in one DOM and
// getByText finds several.
afterEach(cleanup);

/**
 * A node parked mid-removal must never read as hung. Two states look identical to a
 * naive chip and mean completely different things:
 *   - 'unbonding'  — the program holds the bond for an hour; nothing is wrong.
 *   - pendingHostCleanup — chain and funds are DONE, only server-side cleanup is
 *     left, and it needs the user to reconnect over SSH.
 * Both were rendering as a bare "Removing · <stage>", which is what the owner
 * reported as "stuck".
 */

describe('StatusChip during removal', () => {
  it('says when the bond unlocks instead of a bare stage name', () => {
    const unbondsAt = new Date(Date.now() + 25 * 60_000).toISOString();
    render(<StatusChip status="loading" removalStage="unbonding" unbondsAt={unbondsAt} />);
    expect(screen.getByText(/Bond unlocks in \d+m/)).toBeTruthy();
  });

  it('says the bond is unlocked and finishing once the time has passed', () => {
    const unbondsAt = new Date(Date.now() - 60_000).toISOString();
    render(<StatusChip status="loading" removalStage="unbonding" unbondsAt={unbondsAt} />);
    expect(screen.getByText(/Bond unlocked/)).toBeTruthy();
  });

  it('asks for a reconnect when only host cleanup is left, and says funds are already home', () => {
    render(
      <StatusChip
        status="loading"
        removalStage="sweep"
        pendingHostCleanup={{ reason: 'no SSH credentials for this host' }}
      />,
    );
    const chip = screen.getByText('Reconnect to finish');
    expect(chip).toBeTruthy();
    // The tooltip must make clear nothing is at risk, or this still reads as a hang.
    const title = chip.closest('[title]')?.getAttribute('title') ?? '';
    expect(title).toMatch(/already back in your wallet/);
    expect(title).toMatch(/Reconnect/);
    // It must also surface why it could not finish by itself.
    expect(title).toMatch(/no SSH credentials/);
  });

  it('prefers the cleanup message over the stage name for any stage', () => {
    // pendingHostCleanup is only ever set at 'sweep' today, but the chip must not
    // depend on that to avoid reading as hung if the stage machine changes.
    render(
      <StatusChip
        status="loading"
        removalStage="withdraw-bond"
        pendingHostCleanup={{ reason: 'connection refused' }}
      />,
    );
    expect(screen.getByText('Reconnect to finish')).toBeTruthy();
  });
});
