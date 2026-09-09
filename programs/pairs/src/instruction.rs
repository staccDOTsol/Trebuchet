//! Instruction encoding. Data is a one-byte tag followed by little-endian
//! fields in declaration order (no borsh, no IDL needed).

use {
    crate::state::{AUTHORITY_SEED, OFFER_SEED},
    solana_program::{
        instruction::{AccountMeta, Instruction},
        program_error::ProgramError,
        pubkey::Pubkey,
    },
    solana_system_interface::program as system_program,
};

/// Arguments for `InitMarket`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct InitMarketArgs {
    /// 0 = Authority (settler signs), 1 = Whirlpool (permissionless).
    pub settle_kind: u8,
    /// Whirlpool mode: quote A per B instead of B per A.
    pub invert: bool,
    /// Whirlpool mode: settlement price = spot * 10^price_decimals.
    pub price_decimals: u8,
    pub floor_price: u64,
    pub cap_price: u64,
    pub trade_end_slot: u64,
    pub settle_end_slot: u64,
    pub funding_rate_ppm: u64,
    pub funding_period_slots: u64,
    pub max_funding_per_period_ppm: u64,
    pub taker_fee_ppm: u64,
}

/// Instructions supported by the program.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PairsInstruction {
    /// Initialize a market. The client creates every account up front; the
    /// program validates them and writes the market state.
    ///
    ///   0. `[w]` Market account (owned by this program, `Market::LEN` bytes, zeroed)
    ///   1. `[]` Authority PDA `["authority", market]`
    ///   2. `[s]` Creator
    ///   3. `[]` Collateral mint
    ///   4. `[]` Vault: collateral token account owned by the authority PDA
    ///   5. `[]` LONG mint: SPL Token mint, supply 0, mint authority = PDA, no freeze authority
    ///   6. `[]` SHORT mint: same requirements
    ///   7. `[]` Settler pubkey (Authority mode) or Whirlpool account (Whirlpool mode)
    ///   8. `[]` Underlying mint (validated against the whirlpool in Whirlpool mode)
    ///   9. `[]` Collateral token program (SPL Token or Token-2022)
    ///  10. `[]` SPL Token program (position mints)
    InitMarket(InitMarketArgs),

    /// Deposit `amount` collateral and receive `amount` LONG + `amount` SHORT.
    ///
    ///   0. `[]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[s]` User
    ///   3. `[w]` User collateral account
    ///   4. `[w]` Vault
    ///   5. `[w]` LONG mint
    ///   6. `[w]` SHORT mint
    ///   7. `[w]` User LONG account
    ///   8. `[w]` User SHORT account
    ///   9. `[]` Collateral mint
    ///  10. `[]` Collateral token program
    ///  11. `[]` SPL Token program
    MintPairs { amount: u64 },

    /// Burn `amount` LONG + `amount` SHORT and withdraw `amount` collateral.
    /// Allowed at any time while the market is open. Same accounts as
    /// `MintPairs`.
    RedeemPairs { amount: u64 },

    /// Matched trade between two signers. The long side pays
    /// `ceil(size * long_price_ppm / PRICE_SCALE)`, the short side pays the
    /// rest, each receives `size` of their position token.
    ///
    ///   0. `[w]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[s]` Long user
    ///   3. `[s]` Short user
    ///   4. `[w]` Long user collateral account
    ///   5. `[w]` Short user collateral account
    ///   6. `[w]` Vault
    ///   7. `[w]` LONG mint
    ///   8. `[w]` SHORT mint
    ///   9. `[w]` Long user's LONG account
    ///  10. `[w]` Short user's SHORT account
    ///  11. `[]` Collateral mint
    ///  12. `[]` Collateral token program
    ///  13. `[]` SPL Token program
    ///  14. `[w]` Creator fee account (collateral account owned by the creator)
    Trade { size: u64, long_price_ppm: u64 },

    /// Post a resting offer: escrow the maker's side of `size` contracts.
    ///
    ///   0. `[]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[ws]` Maker (pays rent)
    ///   3. `[w]` Maker collateral account
    ///   4. `[w]` Vault
    ///   5. `[w]` Offer PDA `["offer", market, maker, nonce_le]`
    ///   6. `[]` Collateral mint
    ///   7. `[]` Collateral token program
    ///   8. `[]` System program
    PlaceOffer {
        /// 0 = maker wants LONG, 1 = maker wants SHORT
        side: u8,
        long_price_ppm: u64,
        size: u64,
        /// 0 = never expires
        expiry_slot: u64,
        nonce: u64,
    },

    /// Fill up to `size` contracts of an offer. The taker pays the other
    /// side; both parties are minted their position tokens. The offer is
    /// closed (rent to maker) when fully filled.
    ///
    ///   0. `[w]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[w]` Offer
    ///   3. `[w]` Maker (receives rent on close)
    ///   4. `[s]` Taker
    ///   5. `[w]` Taker collateral account
    ///   6. `[w]` Vault
    ///   7. `[w]` LONG mint
    ///   8. `[w]` SHORT mint
    ///   9. `[w]` Maker position account (LONG or SHORT per offer side, owned by maker)
    ///  10. `[w]` Taker position account (the other side, owned by taker)
    ///  11. `[]` Collateral mint
    ///  12. `[]` Collateral token program
    ///  13. `[]` SPL Token program
    ///  14. `[w]` Creator fee account
    FillOffer { size: u64 },

    /// Cancel an offer and return its escrow to the maker. The maker may
    /// cancel any time; anyone may cancel an expired offer or one on a market
    /// that is no longer open.
    ///
    ///   0. `[]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[w]` Offer
    ///   3. `[w]` Maker (receives rent)
    ///   4. `[s]` Signer
    ///   5. `[w]` Maker collateral account
    ///   6. `[w]` Vault
    ///   7. `[]` Collateral mint
    ///   8. `[]` Collateral token program
    CancelOffer,

    /// Record the settlement price. Allowed from `trade_end_slot` through
    /// `settle_end_slot`. In Authority mode the settler must sign and
    /// `price` is used; in Whirlpool mode the whirlpool is read and `price`
    /// is ignored. Funding is accrued one last time before the payout is
    /// fixed.
    ///
    ///   0. `[w]` Market
    ///   1. `[s]` Settler (Authority mode) / `[]` Whirlpool (Whirlpool mode)
    ///   2. `[]` Mark whirlpool (only if the market has one set)
    Settle { price: u64 },

    /// Void an open market whose settlement window has passed: both sides
    /// claim half a unit. Permissionless.
    ///
    ///   0. `[w]` Market
    Void,

    /// After settlement or void: burn positions and withdraw their payout.
    ///
    ///   0. `[]` Market
    ///   1. `[]` Authority PDA
    ///   2. `[s]` User
    ///   3. `[w]` User LONG account
    ///   4. `[w]` User SHORT account
    ///   5. `[w]` LONG mint
    ///   6. `[w]` SHORT mint
    ///   7. `[w]` Vault
    ///   8. `[w]` User collateral account
    ///   9. `[]` Collateral mint
    ///  10. `[]` Collateral token program
    ///  11. `[]` SPL Token program
    Claim { long_amount: u64, short_amount: u64 },

    /// Accrue funding since the last crank. Permissionless in Whirlpool mode;
    /// in Authority mode the settler signs and supplies `index_price`.
    ///
    ///   0. `[w]` Market
    ///   1. `[s]` Settler (Authority mode) / `[]` Whirlpool (Whirlpool mode)
    ///   2. `[]` Mark whirlpool (only if the market has one set)
    Crank { index_price: u64 },

    /// Creator sets the LONG/collateral whirlpool used as the funding mark.
    /// May only be set once, while the market is open.
    ///
    ///   0. `[w]` Market
    ///   1. `[s]` Creator
    ///   2. `[]` Mark whirlpool
    SetMarkWhirlpool,
}

impl PairsInstruction {
    pub fn pack(&self) -> Vec<u8> {
        let mut v = Vec::with_capacity(72);
        match self {
            PairsInstruction::InitMarket(a) => {
                v.push(0);
                v.push(a.settle_kind);
                v.push(a.invert as u8);
                v.push(a.price_decimals);
                for x in [
                    a.floor_price,
                    a.cap_price,
                    a.trade_end_slot,
                    a.settle_end_slot,
                    a.funding_rate_ppm,
                    a.funding_period_slots,
                    a.max_funding_per_period_ppm,
                    a.taker_fee_ppm,
                ] {
                    v.extend_from_slice(&x.to_le_bytes());
                }
            }
            PairsInstruction::MintPairs { amount } => {
                v.push(1);
                v.extend_from_slice(&amount.to_le_bytes());
            }
            PairsInstruction::RedeemPairs { amount } => {
                v.push(2);
                v.extend_from_slice(&amount.to_le_bytes());
            }
            PairsInstruction::Trade {
                size,
                long_price_ppm,
            } => {
                v.push(3);
                v.extend_from_slice(&size.to_le_bytes());
                v.extend_from_slice(&long_price_ppm.to_le_bytes());
            }
            PairsInstruction::PlaceOffer {
                side,
                long_price_ppm,
                size,
                expiry_slot,
                nonce,
            } => {
                v.push(4);
                v.push(*side);
                for x in [long_price_ppm, size, expiry_slot, nonce] {
                    v.extend_from_slice(&x.to_le_bytes());
                }
            }
            PairsInstruction::FillOffer { size } => {
                v.push(5);
                v.extend_from_slice(&size.to_le_bytes());
            }
            PairsInstruction::CancelOffer => v.push(6),
            PairsInstruction::Settle { price } => {
                v.push(7);
                v.extend_from_slice(&price.to_le_bytes());
            }
            PairsInstruction::Void => v.push(8),
            PairsInstruction::Claim {
                long_amount,
                short_amount,
            } => {
                v.push(9);
                v.extend_from_slice(&long_amount.to_le_bytes());
                v.extend_from_slice(&short_amount.to_le_bytes());
            }
            PairsInstruction::Crank { index_price } => {
                v.push(10);
                v.extend_from_slice(&index_price.to_le_bytes());
            }
            PairsInstruction::SetMarkWhirlpool => v.push(11),
        }
        v
    }

    pub fn unpack(input: &[u8]) -> Result<Self, ProgramError> {
        let (&tag, rest) = input
            .split_first()
            .ok_or(ProgramError::InvalidInstructionData)?;
        Ok(match tag {
            0 => {
                if rest.len() != 3 + 8 * 8 {
                    return Err(ProgramError::InvalidInstructionData);
                }
                let f = |i: usize| u64_at(rest, 3 + 8 * i);
                PairsInstruction::InitMarket(InitMarketArgs {
                    settle_kind: rest[0],
                    invert: rest[1] != 0,
                    price_decimals: rest[2],
                    floor_price: f(0),
                    cap_price: f(1),
                    trade_end_slot: f(2),
                    settle_end_slot: f(3),
                    funding_rate_ppm: f(4),
                    funding_period_slots: f(5),
                    max_funding_per_period_ppm: f(6),
                    taker_fee_ppm: f(7),
                })
            }
            1 => PairsInstruction::MintPairs {
                amount: one_u64(rest)?,
            },
            2 => PairsInstruction::RedeemPairs {
                amount: one_u64(rest)?,
            },
            3 => {
                exact(rest, 16)?;
                PairsInstruction::Trade {
                    size: u64_at(rest, 0),
                    long_price_ppm: u64_at(rest, 8),
                }
            }
            4 => {
                exact(rest, 33)?;
                PairsInstruction::PlaceOffer {
                    side: rest[0],
                    long_price_ppm: u64_at(rest, 1),
                    size: u64_at(rest, 9),
                    expiry_slot: u64_at(rest, 17),
                    nonce: u64_at(rest, 25),
                }
            }
            5 => PairsInstruction::FillOffer {
                size: one_u64(rest)?,
            },
            6 => {
                exact(rest, 0)?;
                PairsInstruction::CancelOffer
            }
            7 => PairsInstruction::Settle {
                price: one_u64(rest)?,
            },
            8 => {
                exact(rest, 0)?;
                PairsInstruction::Void
            }
            9 => {
                exact(rest, 16)?;
                PairsInstruction::Claim {
                    long_amount: u64_at(rest, 0),
                    short_amount: u64_at(rest, 8),
                }
            }
            10 => PairsInstruction::Crank {
                index_price: one_u64(rest)?,
            },
            11 => {
                exact(rest, 0)?;
                PairsInstruction::SetMarkWhirlpool
            }
            _ => return Err(ProgramError::InvalidInstructionData),
        })
    }
}

fn exact(rest: &[u8], n: usize) -> Result<(), ProgramError> {
    if rest.len() != n {
        return Err(ProgramError::InvalidInstructionData);
    }
    Ok(())
}

fn one_u64(rest: &[u8]) -> Result<u64, ProgramError> {
    exact(rest, 8)?;
    Ok(u64_at(rest, 0))
}

fn u64_at(src: &[u8], off: usize) -> u64 {
    u64::from_le_bytes(src[off..off + 8].try_into().unwrap())
}

/// Derive the market authority PDA.
pub fn authority_address(program_id: &Pubkey, market: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[AUTHORITY_SEED, market.as_ref()], program_id)
}

/// Derive an offer PDA.
pub fn offer_address(
    program_id: &Pubkey,
    market: &Pubkey,
    maker: &Pubkey,
    nonce: u64,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            OFFER_SEED,
            market.as_ref(),
            maker.as_ref(),
            &nonce.to_le_bytes(),
        ],
        program_id,
    )
}

/// Accounts for `InitMarket`.
pub struct InitMarketAccounts {
    pub market: Pubkey,
    pub creator: Pubkey,
    pub collateral_mint: Pubkey,
    pub vault: Pubkey,
    pub long_mint: Pubkey,
    pub short_mint: Pubkey,
    pub settler: Pubkey,
    pub underlying: Pubkey,
    pub collateral_token_program: Pubkey,
}

pub fn init_market(
    program_id: &Pubkey,
    a: &InitMarketAccounts,
    args: InitMarketArgs,
) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(a.creator, true),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.vault, false),
            AccountMeta::new_readonly(a.long_mint, false),
            AccountMeta::new_readonly(a.short_mint, false),
            AccountMeta::new_readonly(a.settler, false),
            AccountMeta::new_readonly(a.underlying, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
            AccountMeta::new_readonly(crate::token::TOKEN_PROGRAM_ID, false),
        ],
        data: PairsInstruction::InitMarket(args).pack(),
    }
}

/// Accounts shared by `MintPairs`, `RedeemPairs` and `Claim`.
pub struct UserPairAccounts {
    pub market: Pubkey,
    pub user: Pubkey,
    pub user_collateral: Pubkey,
    pub vault: Pubkey,
    pub long_mint: Pubkey,
    pub short_mint: Pubkey,
    pub user_long: Pubkey,
    pub user_short: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
}

fn pair_metas(program_id: &Pubkey, a: &UserPairAccounts) -> Vec<AccountMeta> {
    let (authority, _) = authority_address(program_id, &a.market);
    vec![
        AccountMeta::new_readonly(a.market, false),
        AccountMeta::new_readonly(authority, false),
        AccountMeta::new_readonly(a.user, true),
        AccountMeta::new(a.user_collateral, false),
        AccountMeta::new(a.vault, false),
        AccountMeta::new(a.long_mint, false),
        AccountMeta::new(a.short_mint, false),
        AccountMeta::new(a.user_long, false),
        AccountMeta::new(a.user_short, false),
        AccountMeta::new_readonly(a.collateral_mint, false),
        AccountMeta::new_readonly(a.collateral_token_program, false),
        AccountMeta::new_readonly(crate::token::TOKEN_PROGRAM_ID, false),
    ]
}

pub fn mint_pairs(program_id: &Pubkey, a: &UserPairAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: pair_metas(program_id, a),
        data: PairsInstruction::MintPairs { amount }.pack(),
    }
}

pub fn redeem_pairs(program_id: &Pubkey, a: &UserPairAccounts, amount: u64) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: pair_metas(program_id, a),
        data: PairsInstruction::RedeemPairs { amount }.pack(),
    }
}

pub fn claim(
    program_id: &Pubkey,
    a: &UserPairAccounts,
    long_amount: u64,
    short_amount: u64,
) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(a.user, true),
            AccountMeta::new(a.user_long, false),
            AccountMeta::new(a.user_short, false),
            AccountMeta::new(a.long_mint, false),
            AccountMeta::new(a.short_mint, false),
            AccountMeta::new(a.vault, false),
            AccountMeta::new(a.user_collateral, false),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
            AccountMeta::new_readonly(crate::token::TOKEN_PROGRAM_ID, false),
        ],
        data: PairsInstruction::Claim {
            long_amount,
            short_amount,
        }
        .pack(),
    }
}

/// Accounts for `Trade`.
pub struct TradeAccounts {
    pub market: Pubkey,
    pub long_user: Pubkey,
    pub short_user: Pubkey,
    pub long_user_collateral: Pubkey,
    pub short_user_collateral: Pubkey,
    pub vault: Pubkey,
    pub long_mint: Pubkey,
    pub short_mint: Pubkey,
    pub long_user_long: Pubkey,
    pub short_user_short: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
    pub fee_account: Pubkey,
}

pub fn trade(
    program_id: &Pubkey,
    a: &TradeAccounts,
    size: u64,
    long_price_ppm: u64,
) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new_readonly(a.long_user, true),
            AccountMeta::new_readonly(a.short_user, true),
            AccountMeta::new(a.long_user_collateral, false),
            AccountMeta::new(a.short_user_collateral, false),
            AccountMeta::new(a.vault, false),
            AccountMeta::new(a.long_mint, false),
            AccountMeta::new(a.short_mint, false),
            AccountMeta::new(a.long_user_long, false),
            AccountMeta::new(a.short_user_short, false),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
            AccountMeta::new_readonly(crate::token::TOKEN_PROGRAM_ID, false),
            AccountMeta::new(a.fee_account, false),
        ],
        data: PairsInstruction::Trade {
            size,
            long_price_ppm,
        }
        .pack(),
    }
}

/// Accounts for `PlaceOffer`.
pub struct PlaceOfferAccounts {
    pub market: Pubkey,
    pub maker: Pubkey,
    pub maker_collateral: Pubkey,
    pub vault: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
}

#[allow(clippy::too_many_arguments)]
pub fn place_offer(
    program_id: &Pubkey,
    a: &PlaceOfferAccounts,
    side: u8,
    long_price_ppm: u64,
    size: u64,
    expiry_slot: u64,
    nonce: u64,
) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    let (offer, _) = offer_address(program_id, &a.market, &a.maker, nonce);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new(a.maker, true),
            AccountMeta::new(a.maker_collateral, false),
            AccountMeta::new(a.vault, false),
            AccountMeta::new(offer, false),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
            AccountMeta::new_readonly(system_program::id(), false),
        ],
        data: PairsInstruction::PlaceOffer {
            side,
            long_price_ppm,
            size,
            expiry_slot,
            nonce,
        }
        .pack(),
    }
}

/// Accounts for `FillOffer`.
pub struct FillOfferAccounts {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub taker_collateral: Pubkey,
    pub vault: Pubkey,
    pub long_mint: Pubkey,
    pub short_mint: Pubkey,
    pub maker_position: Pubkey,
    pub taker_position: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
    pub fee_account: Pubkey,
}

pub fn fill_offer(program_id: &Pubkey, a: &FillOfferAccounts, size: u64) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new(a.offer, false),
            AccountMeta::new(a.maker, false),
            AccountMeta::new_readonly(a.taker, true),
            AccountMeta::new(a.taker_collateral, false),
            AccountMeta::new(a.vault, false),
            AccountMeta::new(a.long_mint, false),
            AccountMeta::new(a.short_mint, false),
            AccountMeta::new(a.maker_position, false),
            AccountMeta::new(a.taker_position, false),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
            AccountMeta::new_readonly(crate::token::TOKEN_PROGRAM_ID, false),
            AccountMeta::new(a.fee_account, false),
        ],
        data: PairsInstruction::FillOffer { size }.pack(),
    }
}

/// Accounts for `CancelOffer`.
pub struct CancelOfferAccounts {
    pub market: Pubkey,
    pub offer: Pubkey,
    pub maker: Pubkey,
    pub signer: Pubkey,
    pub maker_collateral: Pubkey,
    pub vault: Pubkey,
    pub collateral_mint: Pubkey,
    pub collateral_token_program: Pubkey,
}

pub fn cancel_offer(program_id: &Pubkey, a: &CancelOfferAccounts) -> Instruction {
    let (authority, _) = authority_address(program_id, &a.market);
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new_readonly(a.market, false),
            AccountMeta::new_readonly(authority, false),
            AccountMeta::new(a.offer, false),
            AccountMeta::new(a.maker, false),
            AccountMeta::new_readonly(a.signer, true),
            AccountMeta::new(a.maker_collateral, false),
            AccountMeta::new(a.vault, false),
            AccountMeta::new_readonly(a.collateral_mint, false),
            AccountMeta::new_readonly(a.collateral_token_program, false),
        ],
        data: PairsInstruction::CancelOffer.pack(),
    }
}

/// `Settle`. `settler_signs` is true in Authority mode. Pass
/// `mark_whirlpool` when the market has one set (final funding accrual).
pub fn settle(
    program_id: &Pubkey,
    market: &Pubkey,
    settler: &Pubkey,
    settler_signs: bool,
    mark_whirlpool: Option<&Pubkey>,
    price: u64,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new_readonly(*settler, settler_signs),
    ];
    if let Some(m) = mark_whirlpool {
        accounts.push(AccountMeta::new_readonly(*m, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: PairsInstruction::Settle { price }.pack(),
    }
}

pub fn void(program_id: &Pubkey, market: &Pubkey) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![AccountMeta::new(*market, false)],
        data: PairsInstruction::Void.pack(),
    }
}

/// `Crank`. Pass `mark_whirlpool` when the market has one set.
pub fn crank(
    program_id: &Pubkey,
    market: &Pubkey,
    settler: &Pubkey,
    settler_signs: bool,
    mark_whirlpool: Option<&Pubkey>,
    index_price: u64,
) -> Instruction {
    let mut accounts = vec![
        AccountMeta::new(*market, false),
        AccountMeta::new_readonly(*settler, settler_signs),
    ];
    if let Some(m) = mark_whirlpool {
        accounts.push(AccountMeta::new_readonly(*m, false));
    }
    Instruction {
        program_id: *program_id,
        accounts,
        data: PairsInstruction::Crank { index_price }.pack(),
    }
}

pub fn set_mark_whirlpool(
    program_id: &Pubkey,
    market: &Pubkey,
    creator: &Pubkey,
    whirlpool: &Pubkey,
) -> Instruction {
    Instruction {
        program_id: *program_id,
        accounts: vec![
            AccountMeta::new(*market, false),
            AccountMeta::new_readonly(*creator, true),
            AccountMeta::new_readonly(*whirlpool, false),
        ],
        data: PairsInstruction::SetMarkWhirlpool.pack(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn roundtrip(ix: PairsInstruction) {
        assert_eq!(PairsInstruction::unpack(&ix.pack()).unwrap(), ix);
    }

    #[test]
    fn pack_unpack_all() {
        roundtrip(PairsInstruction::InitMarket(InitMarketArgs {
            settle_kind: 1,
            invert: true,
            price_decimals: 9,
            floor_price: 1,
            cap_price: 2,
            trade_end_slot: 3,
            settle_end_slot: 4,
            funding_rate_ppm: 5,
            funding_period_slots: 6,
            max_funding_per_period_ppm: 7,
            taker_fee_ppm: 8,
        }));
        roundtrip(PairsInstruction::MintPairs { amount: 9 });
        roundtrip(PairsInstruction::RedeemPairs { amount: 10 });
        roundtrip(PairsInstruction::Trade {
            size: 11,
            long_price_ppm: 12,
        });
        roundtrip(PairsInstruction::PlaceOffer {
            side: 1,
            long_price_ppm: 13,
            size: 14,
            expiry_slot: 15,
            nonce: 16,
        });
        roundtrip(PairsInstruction::FillOffer { size: 17 });
        roundtrip(PairsInstruction::CancelOffer);
        roundtrip(PairsInstruction::Settle { price: 18 });
        roundtrip(PairsInstruction::Void);
        roundtrip(PairsInstruction::Claim {
            long_amount: 19,
            short_amount: 20,
        });
        roundtrip(PairsInstruction::Crank { index_price: 21 });
        roundtrip(PairsInstruction::SetMarkWhirlpool);
        assert!(PairsInstruction::unpack(&[]).is_err());
        assert!(PairsInstruction::unpack(&[1, 0]).is_err());
        assert!(PairsInstruction::unpack(&[99]).is_err());
    }

    /// Fixed bytes shared with `test/pairs-client.test.mjs` so the JS encoder
    /// and the Rust decoder can never drift apart.
    #[test]
    fn cross_language_fixture() {
        let ix = PairsInstruction::PlaceOffer {
            side: 1,
            long_price_ppm: 250_000,
            size: 1_000_000,
            expiry_slot: 0,
            nonce: 7,
        };
        assert_eq!(
            hex(&ix.pack()),
            "0401" // tag, side
                .to_string()
                + "90d0030000000000" // 250000
                + "40420f0000000000" // 1000000
                + "0000000000000000"
                + "0700000000000000"
        );
        let init = PairsInstruction::InitMarket(InitMarketArgs {
            settle_kind: 1,
            invert: false,
            price_decimals: 9,
            floor_price: 900,
            cap_price: 1100,
            trade_end_slot: 1000,
            settle_end_slot: 2000,
            funding_rate_ppm: 1_000_000,
            funding_period_slots: 9000,
            max_funding_per_period_ppm: 100_000,
            taker_fee_ppm: 1000,
        });
        assert_eq!(
            hex(&init.pack()),
            "00010009".to_string()
                + "8403000000000000"
                + "4c04000000000000"
                + "e803000000000000"
                + "d007000000000000"
                + "40420f0000000000"
                + "2823000000000000"
                + "a086010000000000"
                + "e803000000000000"
        );
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
