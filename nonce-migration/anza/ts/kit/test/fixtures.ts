/**
 * Fixed inputs and the outputs the Anza client crate produces for them, frozen
 * by `rust/tests/wire.rs`. The TypeScript port must match byte for byte.
 */

import { type Address, createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey } from '@solana/kit';

export const AUTHORITY_SEED = new Uint8Array(32).fill(7);
export const RECIPIENT = '8qbHbw2BbbTHBW1sbeqakYXVKRQM8Ne7pLK7m6CVfeR' as Address; // [2; 32]
export const NONCE_ACCOUNT = 'CktRuQ2mttgRGkXJtyksdKHjUdc2C4TgDzyB98oEzy8' as Address; // [3; 32]
export const NONCE = 'GgBaCs3NCBuZN12kCJgAW63ydqohFkHEdfdEXBPzLHq' as Address; // [4; 32]
export const AMOUNT = 10_000_000n;

export const EXPECTED_AUTHORITY = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB' as Address;
export const EXPECTED_PDA = 'DPtajHyTTrmEHk3MnyfWVCypdEdyjk1ESbK7UxbaxXqw' as Address;
export const EXPECTED_EXECUTION_MESSAGE =
    'gQEAAQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAEDuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3YCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgIMAAABAgAAAICWmAAAAAAA';
export const EXPECTED_AUTHORIZATION_MESSAGE =
    'gQEAAwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEH6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLPaWlfj5JYuK1SNOpr++SvWDuDtHoo2hDLZ0DIYFQcOAWWGT5rG9fLwDcrw+nggq710Pl+QXhA8DKWM9aBvVZsAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAEBp0AAgEFAgMGAIEBAAEAAAAABAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQBA7gpWCcWhPD3xV9BcXdxLSIb+WV6zLBv//jZjPh9YY92AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAICDAAAAQIAAACAlpgAAAAAAA==';
export const EXPECTED_NEXT_NONCE = 'CWEzUvYuebSfqxWZHrdUg6NcPe5ZzS2PtFAsrKRDWmUn' as Address;

export async function authorityKeyPair() {
    const keyPair = await createKeyPairFromPrivateKeyBytes(AUTHORITY_SEED);
    return { address: await getAddressFromPublicKey(keyPair.publicKey), keyPair };
}

/** The mint the token fixture moves. */
export const MINT = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY' as Address; // [5; 32]

/**
 * The execution message `rust/tests/wire.rs` builds for the token withdrawal.
 * The TypeScript message holds the same instructions but not the same bytes:
 * kit orders the accounts of a compiled message by comparing addresses as
 * strings, the Rust compiler by comparing their bytes. See the README.
 */
export const EXPECTED_TOKEN_EXECUTION_MESSAGE =
    'gQEABQAAAAAEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAIIuClYJxaE8PfFX0Fxd3EtIhv5ZXrMsG//+NmM+H1hj3aA/PR7QF250FyMH2Mx66MuKRQ6hPcnvzA+qLmgC39Zc6ti4cNWPY4zevC9Pc6B8gukAsWYMR7GfDTCMEY38J2ZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBt324ddloZPZy+FGzut5rBy0he1fWzeROoz1hX7/AKmMlyWPTiSJ8bs9ECkUjg2DC1oTmdr/EIQEjnvY2+n4WQcGAQAGBAoAAAEEBQMGAQIFAQAMgJaYAAAAAAAG';
