/**
 * dvpn program errors, numbered as the program DEPLOYED ON DEVNET numbers them.
 *
 * The deployed program is older than the source tree, so its enum differs
 * (sentinel-solana docs/14-DEVNET-LAYOUT-COMPAT.md, divergence 4):
 *   6000–6021  same as source
 *   6022–6038  source code + 1   (source 6022 OpenChannelsRemain does not exist on devnet)
 *   6039       deployed-only "voucher signer is not a valid key"
 *   6040–6045  same as source
 * dvpnctl prints SOURCE names, so for 6022–6039 its printed name is wrong.
 * We always translate by the number.
 */

const SOURCE: Array<[string, string]> = [
  ['Unauthorized', 'signer is not authorized for this action'],
  ['Paused', 'this open is paused'],
  ['FeeAboveCap', 'fee exceeds the maximum'],
  ['ParamOutOfRange', 'parameter out of range'],
  ['NoPendingAuthority', 'no pending authority'],
  ['MalformedMint', 'malformed mint'],
  ['ForbiddenMintExtension', 'mint has a forbidden extension'],
  ['MintNotSealed', 'mint is not sealed'],
  ['VaultNotAssociated', 'vault is not the config associated token account'],
  ['VaultNotImmutable', 'vault is not immutable-owner'],
  ['VaultIsTreasury', 'treasury may not be the vault or config-owned'],
  ['BondBelowMinimum', 'bond below minimum'],
  ['BondPending', 'a parked bond is pending for this id'],
  ['UnbondingNotElapsed', 'unbonding window not elapsed'],
  ['UriTooLong', 'uri too long'],
  ['NodeNotListed', 'node is not listed'],
  ['NodeNotLive', 'node is not live'],
  ['NodePriceChanged', 'node price changed'],
  ['InsufficientRevenue', 'insufficient revenue'],
  ['NoFeesToSweep', 'no fees to sweep'],
  ['ProviderNotListed', 'provider is not listed'],
  ['OpenPlansRemain', 'open plans remain'],
  ['OpenChannelsRemain', 'open channels remain'],
  ['OpenLeasesRemain', 'open leases remain'],
  ['NoBalanceToWithdraw', 'no balance to withdraw'],
  ['AmountExceedsAllowance', 'amount exceeds allowance'],
  ['PlanNotListed', 'plan is not listed'],
  ['PlanNotDelisted', 'plan is not delisted'],
  ['PlanTermsChanged', 'plan terms changed'],
  ['SubscriptionNotExpired', 'subscription not expired'],
  ['SubscriptionPriceNotZero', 'subscription price is not zero'],
  ['LeaseNotOpen', 'lease is not open'],
  ['LeaseNotClosing', 'lease is not closing'],
  ['ChannelNotOpen', 'channel is not open'],
  ['ChannelNotClosing', 'channel is not closing'],
  ['VoucherExceedsEscrow', 'voucher exceeds escrow'],
  ['GraceNotElapsed', 'grace window not elapsed'],
  ['NothingToRedeem', 'nothing to redeem'],
  ['ModeNotVoucher', 'position mode is not voucher'],
  ['ModeNotStream', 'position mode is not stream'],
  ['VoucherSignatureInvalid', 'voucher signature is invalid'],
  ['BatchLengthMismatch', 'batch length mismatch'],
  ['BatchNotSorted', 'batch not sorted'],
  ['NodeReopened', 'position belongs to an earlier incarnation of this node'],
  ['Overflow', 'arithmetic overflow'],
  ['VaultFrozen', 'vault is frozen'],
];

/** Common Anchor framework codes worth naming. */
const ANCHOR: Record<number, [string, string]> = {
  102: ['InstructionDidNotDeserialize', 'instruction arguments did not deserialize'],
  2006: ['ConstraintSeeds', 'an account address does not match its expected PDA'],
  2012: ['ConstraintAddress', 'an account is not the address the program expects'],
  3007: ['AccountOwnedByWrongProgram', 'an account is owned by the wrong program'],
  3012: ['AccountNotInitialized', 'an account the instruction needs does not exist yet'],
};

export interface ProgramError {
  code: number;
  name: string;
  message: string;
}

export function devnetError(code: number): ProgramError {
  if (ANCHOR[code]) return { code, name: ANCHOR[code][0], message: ANCHOR[code][1] };
  const i = code - 6000;
  if (i < 0) return { code, name: `Error${code}`, message: `program error ${code}` };
  if (code === 6039) return { code, name: 'VoucherSignerInvalid', message: 'voucher signer is not a valid key' };
  const src = code >= 6022 && code <= 6038 ? SOURCE[i + 1] : SOURCE[i];
  if (!src) return { code, name: `Error${code}`, message: `program error ${code}` };
  return { code, name: src[0], message: src[1] };
}

/** Find a program error number in dvpnctl / RPC output. */
export function findProgramErrorCode(text: string): number | undefined {
  const hex = /custom program error: 0x([0-9a-f]+)/i.exec(text);
  if (hex) return parseInt(hex[1], 16);
  const num = /Error Number: (\d+)/.exec(text);
  if (num) return Number(num[1]);
  const paren = /program error: \w+ \((\d{3,4})\)/.exec(text);
  if (paren) return Number(paren[1]);
  return undefined;
}

/** Human message for a failure, naming the program error correctly when present. */
export function describeFailure(text: string): string {
  const code = findProgramErrorCode(text);
  if (code === undefined) return text.trim().slice(-600);
  const e = devnetError(code);
  return `${e.message} (${e.name}, ${code})`;
}
