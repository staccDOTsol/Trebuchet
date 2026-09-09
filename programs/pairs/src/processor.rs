//! Instruction processor.

use {
    crate::{
        error::PairsError,
        instruction::{InitMarketArgs, PairsInstruction},
        math,
        state::{
            Market, MarketStatus, Offer, SettleKind, Side, AUTHORITY_SEED, OFFER_SEED, PRICE_SCALE,
            VERSION,
        },
        token,
    },
    solana_program::{
        account_info::{next_account_info, AccountInfo},
        clock::Clock,
        entrypoint::ProgramResult,
        msg,
        program::invoke_signed,
        program_error::ProgramError,
        pubkey,
        pubkey::Pubkey,
        rent::Rent,
        sysvar::Sysvar,
    },
    solana_system_interface::{instruction as system_instruction, program as system_program},
};

/// Orca Whirlpools program.
pub const WHIRLPOOL_PROGRAM_ID: Pubkey = pubkey!("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc");
/// Anchor discriminator of a `Whirlpool` account: `sha256("account:Whirlpool")[..8]`.
pub const WHIRLPOOL_DISCRIMINATOR: [u8; 8] = [63, 149, 209, 12, 225, 128, 99, 9];
/// Bytes of a `Whirlpool` account we need to read (through `token_mint_b`).
pub const WHIRLPOOL_MIN_LEN: usize = 213;
/// Upper bound on the taker fee (10%).
pub const MAX_TAKER_FEE_PPM: u64 = 100_000;

/// Fields read from an Orca Whirlpool account.
pub struct WhirlpoolView {
    pub sqrt_price: u128,
    pub token_mint_a: Pubkey,
    pub token_mint_b: Pubkey,
}

/// Read the spot price and mints of a whirlpool. Only accepts accounts owned
/// by the Orca program that carry the `Whirlpool` discriminator.
pub fn read_whirlpool(info: &AccountInfo) -> Result<WhirlpoolView, ProgramError> {
    if *info.owner != WHIRLPOOL_PROGRAM_ID {
        return Err(PairsError::InvalidWhirlpool.into());
    }
    let data = info.try_borrow_data()?;
    if data.len() < WHIRLPOOL_MIN_LEN || data[0..8] != WHIRLPOOL_DISCRIMINATOR {
        return Err(PairsError::InvalidWhirlpool.into());
    }
    Ok(WhirlpoolView {
        sqrt_price: u128::from_le_bytes(data[65..81].try_into().unwrap()),
        token_mint_a: Pubkey::new_from_array(data[101..133].try_into().unwrap()),
        token_mint_b: Pubkey::new_from_array(data[181..213].try_into().unwrap()),
    })
}

/// Entry point used by both the SBF entrypoint and `solana-program-test`.
pub fn process_instruction(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    instruction_data: &[u8],
) -> ProgramResult {
    let instruction = PairsInstruction::unpack(instruction_data)?;
    match instruction {
        PairsInstruction::InitMarket(args) => {
            msg!("Instruction: InitMarket");
            process_init_market(program_id, accounts, args)
        }
        PairsInstruction::MintPairs { amount } => {
            msg!("Instruction: MintPairs");
            process_mint_or_redeem(program_id, accounts, amount, true)
        }
        PairsInstruction::RedeemPairs { amount } => {
            msg!("Instruction: RedeemPairs");
            process_mint_or_redeem(program_id, accounts, amount, false)
        }
        PairsInstruction::Trade {
            size,
            long_price_ppm,
        } => {
            msg!("Instruction: Trade");
            process_trade(program_id, accounts, size, long_price_ppm)
        }
        PairsInstruction::PlaceOffer {
            side,
            long_price_ppm,
            size,
            expiry_slot,
            nonce,
        } => {
            msg!("Instruction: PlaceOffer");
            process_place_offer(
                program_id,
                accounts,
                side,
                long_price_ppm,
                size,
                expiry_slot,
                nonce,
            )
        }
        PairsInstruction::FillOffer { size } => {
            msg!("Instruction: FillOffer");
            process_fill_offer(program_id, accounts, size)
        }
        PairsInstruction::CancelOffer => {
            msg!("Instruction: CancelOffer");
            process_cancel_offer(program_id, accounts)
        }
        PairsInstruction::Settle { price } => {
            msg!("Instruction: Settle");
            process_settle(program_id, accounts, price)
        }
        PairsInstruction::Void => {
            msg!("Instruction: Void");
            process_void(program_id, accounts)
        }
        PairsInstruction::Claim {
            long_amount,
            short_amount,
        } => {
            msg!("Instruction: Claim");
            process_claim(program_id, accounts, long_amount, short_amount)
        }
        PairsInstruction::Crank { index_price } => {
            msg!("Instruction: Crank");
            process_crank(program_id, accounts, index_price)
        }
        PairsInstruction::SetMarkWhirlpool => {
            msg!("Instruction: SetMarkWhirlpool");
            process_set_mark_whirlpool(program_id, accounts)
        }
    }
}

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

/// A loaded market plus its verified authority PDA.
struct Ctx<'a, 'b> {
    market_info: &'a AccountInfo<'b>,
    market: Market,
    authority_info: &'a AccountInfo<'b>,
    bump: [u8; 1],
}

impl<'a, 'b> Ctx<'a, 'b> {
    fn load(
        program_id: &Pubkey,
        market_info: &'a AccountInfo<'b>,
        authority_info: &'a AccountInfo<'b>,
    ) -> Result<Self, ProgramError> {
        if market_info.owner != program_id {
            return Err(PairsError::IncorrectOwner.into());
        }
        let market = Market::unpack(&market_info.try_borrow_data()?)?;
        let expected = Pubkey::create_program_address(
            &[AUTHORITY_SEED, market_info.key.as_ref(), &[market.bump]],
            program_id,
        )
        .map_err(|_| PairsError::InvalidAuthority)?;
        if expected != *authority_info.key {
            return Err(PairsError::InvalidAuthority.into());
        }
        Ok(Ctx {
            market_info,
            bump: [market.bump],
            market,
            authority_info,
        })
    }

    fn seeds(&self) -> [&[u8]; 3] {
        [AUTHORITY_SEED, self.market_info.key.as_ref(), &self.bump]
    }

    fn save(&self) -> ProgramResult {
        self.market
            .pack_into(&mut self.market_info.try_borrow_mut_data()?)
    }

    fn require_open(&self) -> ProgramResult {
        if self.market.status != MarketStatus::Open {
            return Err(PairsError::MarketNotOpen.into());
        }
        Ok(())
    }

    fn require_trading(&self, slot: u64) -> ProgramResult {
        self.require_open()?;
        if slot >= self.market.trade_end_slot {
            return Err(PairsError::TradingClosed.into());
        }
        Ok(())
    }

    fn check_programs(&self, collateral_tp: &AccountInfo, tp: &AccountInfo) -> ProgramResult {
        if *collateral_tp.key != self.market.collateral_token_program {
            return Err(PairsError::InvalidTokenProgram.into());
        }
        if *tp.key != token::TOKEN_PROGRAM_ID {
            return Err(PairsError::InvalidTokenProgram.into());
        }
        Ok(())
    }

    fn check_collateral_program(&self, collateral_tp: &AccountInfo) -> ProgramResult {
        if *collateral_tp.key != self.market.collateral_token_program {
            return Err(PairsError::InvalidTokenProgram.into());
        }
        Ok(())
    }

    fn check_vault(&self, vault: &AccountInfo) -> ProgramResult {
        if *vault.key != self.market.vault {
            return Err(PairsError::InvalidTokenAccount.into());
        }
        Ok(())
    }

    fn check_mints(&self, long_mint: &AccountInfo, short_mint: &AccountInfo) -> ProgramResult {
        if *long_mint.key != self.market.long_mint || *short_mint.key != self.market.short_mint {
            return Err(PairsError::InvalidMint.into());
        }
        Ok(())
    }

    /// Validate the collateral mint account and return its decimals.
    fn collateral_decimals(&self, mint: &AccountInfo) -> Result<u8, ProgramError> {
        if *mint.key != self.market.collateral_mint {
            return Err(PairsError::InvalidMint.into());
        }
        Ok(token::unpack_mint(mint, &self.market.collateral_token_program)?.decimals)
    }

    /// A user's collateral token account (mint must match; owner if given).
    fn check_collateral_account(
        &self,
        info: &AccountInfo,
        owner: Option<&Pubkey>,
    ) -> Result<token::TokenAccountState, ProgramError> {
        let acct = token::unpack_token_account(info, &self.market.collateral_token_program)?;
        if acct.mint != self.market.collateral_mint {
            return Err(PairsError::InvalidTokenAccount.into());
        }
        if let Some(o) = owner {
            if acct.owner != *o {
                return Err(PairsError::InvalidTokenAccount.into());
            }
        }
        Ok(acct)
    }

    /// A position (LONG/SHORT) token account for `mint` owned by `owner`.
    fn check_position_account(
        &self,
        info: &AccountInfo,
        mint: &Pubkey,
        owner: &Pubkey,
    ) -> Result<token::TokenAccountState, ProgramError> {
        let acct = token::unpack_token_account(info, &token::TOKEN_PROGRAM_ID)?;
        if acct.mint != *mint || acct.owner != *owner {
            return Err(PairsError::InvalidTokenAccount.into());
        }
        Ok(acct)
    }

    /// Pull `amount` collateral from `from` (signed by `owner`) into the
    /// vault, requiring the vault to receive exactly `amount`.
    #[allow(clippy::too_many_arguments)]
    fn deposit(
        &self,
        collateral_tp: &AccountInfo<'b>,
        from: &AccountInfo<'b>,
        mint: &AccountInfo<'b>,
        vault: &AccountInfo<'b>,
        owner: &AccountInfo<'b>,
        amount: u64,
        decimals: u8,
    ) -> ProgramResult {
        if amount == 0 {
            return Ok(());
        }
        let before = token::account_amount(vault)?;
        token::transfer_checked(
            collateral_tp,
            from,
            mint,
            vault,
            owner,
            amount,
            decimals,
            None,
        )?;
        let after = token::account_amount(vault)?;
        if after.checked_sub(before) != Some(amount) {
            return Err(PairsError::TransferAmountMismatch.into());
        }
        Ok(())
    }

    /// Pay `amount` collateral from the vault to `to`, signed by the PDA.
    fn withdraw(
        &self,
        collateral_tp: &AccountInfo<'b>,
        vault: &AccountInfo<'b>,
        mint: &AccountInfo<'b>,
        to: &AccountInfo<'b>,
        amount: u64,
        decimals: u8,
    ) -> ProgramResult {
        if amount == 0 {
            return Ok(());
        }
        let seeds = self.seeds();
        token::transfer_checked(
            collateral_tp,
            vault,
            mint,
            to,
            self.authority_info,
            amount,
            decimals,
            Some(&seeds),
        )
    }

    fn mint_position(
        &self,
        tp: &AccountInfo<'b>,
        mint: &AccountInfo<'b>,
        to: &AccountInfo<'b>,
        amount: u64,
    ) -> ProgramResult {
        if amount == 0 {
            return Ok(());
        }
        let seeds = self.seeds();
        token::mint_to(tp, mint, to, self.authority_info, amount, &seeds)
    }

    /// Charge the taker fee from `payer` to the creator's fee account.
    #[allow(clippy::too_many_arguments)]
    fn charge_fee(
        &self,
        collateral_tp: &AccountInfo<'b>,
        payer_collateral: &AccountInfo<'b>,
        mint: &AccountInfo<'b>,
        fee_account: &AccountInfo<'b>,
        payer: &AccountInfo<'b>,
        notional: u64,
        decimals: u8,
    ) -> ProgramResult {
        if self.market.taker_fee_ppm == 0 {
            return Ok(());
        }
        self.check_collateral_account(fee_account, Some(&self.market.creator))?;
        let fee = math::fee(notional, self.market.taker_fee_ppm)?;
        token::transfer_checked(
            collateral_tp,
            payer_collateral,
            mint,
            fee_account,
            payer,
            fee,
            decimals,
            None,
        )
    }

    /// Fold a trade into the VWAP accumulators used as the funding mark.
    fn record_trade(&mut self, size: u64, long_price_ppm: u64) -> ProgramResult {
        let add = (size as u128)
            .checked_mul(long_price_ppm as u128)
            .ok_or(PairsError::Overflow)?;
        self.market.vwap_num = self
            .market
            .vwap_num
            .checked_add(add)
            .ok_or(PairsError::Overflow)?;
        self.market.vwap_den = self
            .market
            .vwap_den
            .checked_add(size)
            .ok_or(PairsError::Overflow)?;
        Ok(())
    }

    /// Resolve the index price from the settler account per settle kind.
    fn index_price(&self, settler_info: &AccountInfo, price_arg: u64) -> Result<u64, ProgramError> {
        if *settler_info.key != self.market.settler {
            return Err(PairsError::WrongSettler.into());
        }
        match self.market.settle_kind {
            SettleKind::Authority => {
                if !settler_info.is_signer {
                    return Err(PairsError::MissingSignature.into());
                }
                Ok(price_arg)
            }
            SettleKind::Whirlpool => {
                let wp = read_whirlpool(settler_info)?;
                math::whirlpool_price(
                    wp.sqrt_price,
                    self.market.price_decimals,
                    self.market.invert,
                )
            }
        }
    }

    /// Accrue funding from `last_crank_slot` to `slot` against `index_price`.
    fn accrue_funding(
        &mut self,
        index_price: u64,
        slot: u64,
        mark_whirlpool: Option<&AccountInfo>,
    ) -> ProgramResult {
        if slot <= self.market.last_crank_slot {
            return Ok(());
        }
        let elapsed = slot - self.market.last_crank_slot;
        let m = &mut self.market;
        let intrinsic = math::intrinsic_ppm(index_price, m.floor_price, m.cap_price);
        let mark: Option<u64> = if m.has_mark_whirlpool() {
            let info = mark_whirlpool.ok_or(ProgramError::NotEnoughAccountKeys)?;
            if *info.key != m.mark_whirlpool {
                return Err(PairsError::InvalidWhirlpool.into());
            }
            let wp = read_whirlpool(info)?;
            Some(math::whirlpool_mark_ppm(wp.sqrt_price, m.mark_invert)?)
        } else if m.vwap_den > 0 {
            Some((m.vwap_num / m.vwap_den as u128) as u64)
        } else {
            None
        };
        if let Some(mark) = mark {
            let premium = mark as i128 - intrinsic as i128;
            let accrual = math::funding_accrual(
                premium,
                m.funding_rate_ppm,
                m.funding_period_slots,
                m.max_funding_per_period_ppm,
                elapsed,
            )?;
            m.funding_offset_ppm = math::apply_funding(m.funding_offset_ppm, accrual);
        }
        m.vwap_num = 0;
        m.vwap_den = 0;
        m.last_crank_slot = slot;
        m.last_index_price = index_price;
        Ok(())
    }
}

fn require_signer(info: &AccountInfo) -> ProgramResult {
    if !info.is_signer {
        return Err(PairsError::MissingSignature.into());
    }
    Ok(())
}

fn check_price(long_price_ppm: u64) -> ProgramResult {
    if long_price_ppm == 0 || long_price_ppm >= PRICE_SCALE {
        return Err(PairsError::InvalidPrice.into());
    }
    Ok(())
}

fn nonzero(amount: u64) -> ProgramResult {
    if amount == 0 {
        return Err(PairsError::ZeroAmount.into());
    }
    Ok(())
}

fn current_slot() -> Result<u64, ProgramError> {
    Ok(Clock::get()?.slot)
}

/// Load an offer belonging to `market`, verifying `maker_info`.
fn load_offer(
    program_id: &Pubkey,
    offer_info: &AccountInfo,
    market_key: &Pubkey,
    maker_info: &AccountInfo,
) -> Result<Offer, ProgramError> {
    if offer_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    let offer = Offer::unpack(&offer_info.try_borrow_data()?)?;
    if offer.market != *market_key {
        return Err(PairsError::OfferMarketMismatch.into());
    }
    if offer.maker != *maker_info.key {
        return Err(PairsError::InvalidOfferAddress.into());
    }
    Ok(offer)
}

/// Drain an account's lamports to `dest` and hand it back to the system
/// program so the runtime reclaims it.
fn close_account(target: &AccountInfo, dest: &AccountInfo) -> ProgramResult {
    let lamports = target.lamports();
    {
        let mut dest_lamports = dest.try_borrow_mut_lamports()?;
        **dest_lamports = dest_lamports
            .checked_add(lamports)
            .ok_or(PairsError::Overflow)?;
    }
    **target.try_borrow_mut_lamports()? = 0;
    target.resize(0)?;
    target.assign(&system_program::id());
    Ok(())
}

// ---------------------------------------------------------------------------
// handlers
// ---------------------------------------------------------------------------

fn process_init_market(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    args: InitMarketArgs,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let creator_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let long_mint_info = next_account_info(it)?;
    let short_mint_info = next_account_info(it)?;
    let settler_info = next_account_info(it)?;
    let underlying_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let tp_info = next_account_info(it)?;

    require_signer(creator_info)?;
    if market_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    {
        let data = market_info.try_borrow_data()?;
        if data.len() < Market::LEN {
            return Err(ProgramError::AccountDataTooSmall);
        }
        if Market::is_initialized(&data) {
            return Err(PairsError::AlreadyInUse.into());
        }
    }
    if !Rent::get()?.is_exempt(market_info.lamports(), market_info.data_len()) {
        return Err(ProgramError::AccountNotRentExempt);
    }
    if !token::is_token_program(collateral_tp_info.key) || *tp_info.key != token::TOKEN_PROGRAM_ID {
        return Err(PairsError::InvalidTokenProgram.into());
    }

    let settle_kind = SettleKind::from_u8(args.settle_kind)?;
    let slot = current_slot()?;
    if args.floor_price >= args.cap_price {
        return Err(PairsError::InvalidRange.into());
    }
    if args.trade_end_slot <= slot || args.settle_end_slot <= args.trade_end_slot {
        return Err(PairsError::InvalidSchedule.into());
    }
    if args.price_decimals > math::MAX_PRICE_DECIMALS {
        return Err(PairsError::InvalidPriceDecimals.into());
    }
    if args.funding_rate_ppm > 0 && args.funding_period_slots == 0 {
        return Err(PairsError::InvalidSchedule.into());
    }
    if args.taker_fee_ppm > MAX_TAKER_FEE_PPM {
        return Err(PairsError::InvalidPrice.into());
    }

    let (authority, bump) =
        Pubkey::find_program_address(&[AUTHORITY_SEED, market_info.key.as_ref()], program_id);
    if authority != *authority_info.key {
        return Err(PairsError::InvalidAuthority.into());
    }

    let collateral_mint = token::unpack_mint(collateral_mint_info, collateral_tp_info.key)?;
    let vault = token::unpack_token_account(vault_info, collateral_tp_info.key)?;
    if vault.mint != *collateral_mint_info.key
        || vault.owner != authority
        || vault.amount != 0
        || vault.state != 1
    {
        return Err(PairsError::InvalidTokenAccount.into());
    }
    if long_mint_info.key == short_mint_info.key {
        return Err(PairsError::InvalidPositionMint.into());
    }
    for mint_info in [long_mint_info, short_mint_info] {
        let m = token::unpack_mint(mint_info, &token::TOKEN_PROGRAM_ID)?;
        if m.mint_authority != Some(authority)
            || m.supply != 0
            || m.freeze_authority.is_some()
            || m.decimals != collateral_mint.decimals
        {
            return Err(PairsError::InvalidPositionMint.into());
        }
    }
    if settle_kind == SettleKind::Whirlpool {
        let wp = read_whirlpool(settler_info)?;
        let priced = if args.invert {
            wp.token_mint_b
        } else {
            wp.token_mint_a
        };
        if priced != *underlying_info.key {
            return Err(PairsError::InvalidWhirlpool.into());
        }
    }

    let market = Market {
        version: VERSION,
        bump,
        settle_kind,
        invert: args.invert,
        price_decimals: args.price_decimals,
        status: MarketStatus::Open,
        creator: *creator_info.key,
        collateral_mint: *collateral_mint_info.key,
        collateral_token_program: *collateral_tp_info.key,
        vault: *vault_info.key,
        long_mint: *long_mint_info.key,
        short_mint: *short_mint_info.key,
        settler: *settler_info.key,
        underlying: *underlying_info.key,
        floor_price: args.floor_price,
        cap_price: args.cap_price,
        trade_end_slot: args.trade_end_slot,
        settle_end_slot: args.settle_end_slot,
        settlement_price: 0,
        long_payout_ppm: 0,
        settled_slot: 0,
        funding_rate_ppm: args.funding_rate_ppm,
        funding_period_slots: args.funding_period_slots,
        max_funding_per_period_ppm: args.max_funding_per_period_ppm,
        funding_offset_ppm: 0,
        last_crank_slot: slot,
        vwap_num: 0,
        vwap_den: 0,
        last_index_price: 0,
        taker_fee_ppm: args.taker_fee_ppm,
        mark_whirlpool: Pubkey::default(),
        mark_invert: false,
    };
    market.pack_into(&mut market_info.try_borrow_mut_data()?)
}

fn process_mint_or_redeem(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    amount: u64,
    is_mint: bool,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let user_info = next_account_info(it)?;
    let user_collateral_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let long_mint_info = next_account_info(it)?;
    let short_mint_info = next_account_info(it)?;
    let user_long_info = next_account_info(it)?;
    let user_short_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let tp_info = next_account_info(it)?;

    nonzero(amount)?;
    require_signer(user_info)?;
    let ctx = Ctx::load(program_id, market_info, authority_info)?;
    if is_mint {
        ctx.require_trading(current_slot()?)?;
    } else {
        ctx.require_open()?;
    }
    ctx.check_programs(collateral_tp_info, tp_info)?;
    ctx.check_mints(long_mint_info, short_mint_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    ctx.check_collateral_account(user_collateral_info, Some(user_info.key))?;
    ctx.check_position_account(user_long_info, long_mint_info.key, user_info.key)?;
    ctx.check_position_account(user_short_info, short_mint_info.key, user_info.key)?;

    if is_mint {
        ctx.deposit(
            collateral_tp_info,
            user_collateral_info,
            collateral_mint_info,
            vault_info,
            user_info,
            amount,
            decimals,
        )?;
        ctx.mint_position(tp_info, long_mint_info, user_long_info, amount)?;
        ctx.mint_position(tp_info, short_mint_info, user_short_info, amount)?;
    } else {
        token::burn(tp_info, user_long_info, long_mint_info, user_info, amount)?;
        token::burn(tp_info, user_short_info, short_mint_info, user_info, amount)?;
        ctx.withdraw(
            collateral_tp_info,
            vault_info,
            collateral_mint_info,
            user_collateral_info,
            amount,
            decimals,
        )?;
    }
    Ok(())
}

fn process_trade(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    size: u64,
    long_price_ppm: u64,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let long_user_info = next_account_info(it)?;
    let short_user_info = next_account_info(it)?;
    let long_coll_info = next_account_info(it)?;
    let short_coll_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let long_mint_info = next_account_info(it)?;
    let short_mint_info = next_account_info(it)?;
    let long_pos_info = next_account_info(it)?;
    let short_pos_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let tp_info = next_account_info(it)?;
    let fee_info = next_account_info(it)?;

    nonzero(size)?;
    check_price(long_price_ppm)?;
    require_signer(long_user_info)?;
    require_signer(short_user_info)?;
    if long_user_info.key == short_user_info.key {
        return Err(PairsError::SameCounterparty.into());
    }
    let mut ctx = Ctx::load(program_id, market_info, authority_info)?;
    ctx.require_trading(current_slot()?)?;
    ctx.check_programs(collateral_tp_info, tp_info)?;
    ctx.check_mints(long_mint_info, short_mint_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    ctx.check_collateral_account(long_coll_info, Some(long_user_info.key))?;
    ctx.check_collateral_account(short_coll_info, Some(short_user_info.key))?;
    ctx.check_position_account(long_pos_info, long_mint_info.key, long_user_info.key)?;
    ctx.check_position_account(short_pos_info, short_mint_info.key, short_user_info.key)?;

    let long_pays = math::long_share(size, long_price_ppm)?;
    let short_pays = size - long_pays;
    ctx.charge_fee(
        collateral_tp_info,
        long_coll_info,
        collateral_mint_info,
        fee_info,
        long_user_info,
        size,
        decimals,
    )?;
    ctx.charge_fee(
        collateral_tp_info,
        short_coll_info,
        collateral_mint_info,
        fee_info,
        short_user_info,
        size,
        decimals,
    )?;
    ctx.deposit(
        collateral_tp_info,
        long_coll_info,
        collateral_mint_info,
        vault_info,
        long_user_info,
        long_pays,
        decimals,
    )?;
    ctx.deposit(
        collateral_tp_info,
        short_coll_info,
        collateral_mint_info,
        vault_info,
        short_user_info,
        short_pays,
        decimals,
    )?;
    ctx.mint_position(tp_info, long_mint_info, long_pos_info, size)?;
    ctx.mint_position(tp_info, short_mint_info, short_pos_info, size)?;
    ctx.record_trade(size, long_price_ppm)?;
    ctx.save()
}

#[allow(clippy::too_many_arguments)]
fn process_place_offer(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    side: u8,
    long_price_ppm: u64,
    size: u64,
    expiry_slot: u64,
    nonce: u64,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let maker_info = next_account_info(it)?;
    let maker_coll_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let offer_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let system_info = next_account_info(it)?;

    nonzero(size)?;
    check_price(long_price_ppm)?;
    let side = Side::from_u8(side)?;
    require_signer(maker_info)?;
    if *system_info.key != system_program::id() {
        return Err(ProgramError::IncorrectProgramId);
    }
    let slot = current_slot()?;
    if expiry_slot != 0 && expiry_slot <= slot {
        return Err(PairsError::OfferExpired.into());
    }
    let ctx = Ctx::load(program_id, market_info, authority_info)?;
    ctx.require_trading(slot)?;
    ctx.check_collateral_program(collateral_tp_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    ctx.check_collateral_account(maker_coll_info, Some(maker_info.key))?;

    let long_part = math::long_share(size, long_price_ppm)?;
    let escrow = match side {
        Side::Long => long_part,
        Side::Short => size - long_part,
    };

    let nonce_bytes = nonce.to_le_bytes();
    let (offer_key, bump) = Pubkey::find_program_address(
        &[
            OFFER_SEED,
            market_info.key.as_ref(),
            maker_info.key.as_ref(),
            &nonce_bytes,
        ],
        program_id,
    );
    if offer_key != *offer_info.key {
        return Err(PairsError::InvalidOfferAddress.into());
    }
    if offer_info.lamports() != 0
        || !offer_info.data_is_empty()
        || *offer_info.owner != system_program::id()
    {
        return Err(PairsError::AlreadyInUse.into());
    }
    let lamports = Rent::get()?.minimum_balance(Offer::LEN);
    invoke_signed(
        &system_instruction::create_account(
            maker_info.key,
            offer_info.key,
            lamports,
            Offer::LEN as u64,
            program_id,
        ),
        &[maker_info.clone(), offer_info.clone(), system_info.clone()],
        &[&[
            OFFER_SEED,
            market_info.key.as_ref(),
            maker_info.key.as_ref(),
            &nonce_bytes,
            &[bump],
        ]],
    )?;

    ctx.deposit(
        collateral_tp_info,
        maker_coll_info,
        collateral_mint_info,
        vault_info,
        maker_info,
        escrow,
        decimals,
    )?;

    let offer = Offer {
        version: VERSION,
        bump,
        side,
        market: *market_info.key,
        maker: *maker_info.key,
        nonce,
        long_price_ppm,
        remaining: size,
        escrowed: escrow,
        expiry_slot,
    };
    offer.pack_into(&mut offer_info.try_borrow_mut_data()?)
}

fn process_fill_offer(program_id: &Pubkey, accounts: &[AccountInfo], size: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let offer_info = next_account_info(it)?;
    let maker_info = next_account_info(it)?;
    let taker_info = next_account_info(it)?;
    let taker_coll_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let long_mint_info = next_account_info(it)?;
    let short_mint_info = next_account_info(it)?;
    let maker_pos_info = next_account_info(it)?;
    let taker_pos_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let tp_info = next_account_info(it)?;
    let fee_info = next_account_info(it)?;

    nonzero(size)?;
    require_signer(taker_info)?;
    if taker_info.key == maker_info.key {
        return Err(PairsError::SelfTrade.into());
    }
    let slot = current_slot()?;
    let mut ctx = Ctx::load(program_id, market_info, authority_info)?;
    ctx.require_trading(slot)?;
    ctx.check_programs(collateral_tp_info, tp_info)?;
    ctx.check_mints(long_mint_info, short_mint_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    ctx.check_collateral_account(taker_coll_info, Some(taker_info.key))?;

    let mut offer = load_offer(program_id, offer_info, market_info.key, maker_info)?;
    if offer.expiry_slot != 0 && slot > offer.expiry_slot {
        return Err(PairsError::OfferExpired.into());
    }
    let fill = size.min(offer.remaining);
    nonzero(fill)?;
    let maker_part = math::maker_share(offer.escrowed, offer.remaining, fill)?;
    let taker_part = fill.checked_sub(maker_part).ok_or(PairsError::Overflow)?;

    let (maker_mint_info, taker_mint_info) = match offer.side {
        Side::Long => (long_mint_info, short_mint_info),
        Side::Short => (short_mint_info, long_mint_info),
    };
    ctx.check_position_account(maker_pos_info, maker_mint_info.key, maker_info.key)?;
    ctx.check_position_account(taker_pos_info, taker_mint_info.key, taker_info.key)?;

    ctx.charge_fee(
        collateral_tp_info,
        taker_coll_info,
        collateral_mint_info,
        fee_info,
        taker_info,
        fill,
        decimals,
    )?;
    ctx.deposit(
        collateral_tp_info,
        taker_coll_info,
        collateral_mint_info,
        vault_info,
        taker_info,
        taker_part,
        decimals,
    )?;
    ctx.mint_position(tp_info, maker_mint_info, maker_pos_info, fill)?;
    ctx.mint_position(tp_info, taker_mint_info, taker_pos_info, fill)?;
    ctx.record_trade(fill, offer.long_price_ppm)?;

    offer.remaining -= fill;
    offer.escrowed -= maker_part;
    if offer.remaining == 0 {
        close_account(offer_info, maker_info)?;
    } else {
        offer.pack_into(&mut offer_info.try_borrow_mut_data()?)?;
    }
    ctx.save()
}

fn process_cancel_offer(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let offer_info = next_account_info(it)?;
    let maker_info = next_account_info(it)?;
    let signer_info = next_account_info(it)?;
    let maker_coll_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;

    require_signer(signer_info)?;
    let ctx = Ctx::load(program_id, market_info, authority_info)?;
    ctx.check_collateral_program(collateral_tp_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    let offer = load_offer(program_id, offer_info, market_info.key, maker_info)?;
    if signer_info.key != maker_info.key {
        let slot = current_slot()?;
        let expired = offer.expiry_slot != 0 && slot > offer.expiry_slot;
        let dead = ctx.market.status != MarketStatus::Open || slot >= ctx.market.trade_end_slot;
        if !(expired || dead) {
            return Err(PairsError::OfferNotCancellable.into());
        }
    }
    ctx.check_collateral_account(maker_coll_info, Some(maker_info.key))?;
    ctx.withdraw(
        collateral_tp_info,
        vault_info,
        collateral_mint_info,
        maker_coll_info,
        offer.escrowed,
        decimals,
    )?;
    close_account(offer_info, maker_info)
}

fn process_settle(program_id: &Pubkey, accounts: &[AccountInfo], price: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let settler_info = next_account_info(it)?;
    let mark_info = next_account_info(it).ok();

    if market_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    let market = Market::unpack(&market_info.try_borrow_data()?)?;
    // Settle does not need the authority PDA; build a Ctx-like view manually.
    let mut ctx = Ctx {
        market_info,
        bump: [market.bump],
        market,
        authority_info: market_info,
    };
    ctx.require_open()?;
    let slot = current_slot()?;
    if slot < ctx.market.trade_end_slot || slot > ctx.market.settle_end_slot {
        return Err(PairsError::OutsideSettlementWindow.into());
    }
    let index_price = ctx.index_price(settler_info, price)?;
    ctx.accrue_funding(index_price, slot, mark_info)?;
    let intrinsic = math::intrinsic_ppm(index_price, ctx.market.floor_price, ctx.market.cap_price);
    ctx.market.long_payout_ppm =
        math::settlement_payout_ppm(intrinsic, ctx.market.funding_offset_ppm);
    ctx.market.settlement_price = index_price;
    ctx.market.status = MarketStatus::Settled;
    ctx.market.settled_slot = slot;
    ctx.save()
}

fn process_void(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    if market_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    let mut market = Market::unpack(&market_info.try_borrow_data()?)?;
    if market.status != MarketStatus::Open {
        return Err(PairsError::MarketNotOpen.into());
    }
    let slot = current_slot()?;
    if slot <= market.settle_end_slot {
        return Err(PairsError::OutsideSettlementWindow.into());
    }
    market.long_payout_ppm = PRICE_SCALE / 2;
    market.status = MarketStatus::Void;
    market.settled_slot = slot;
    market.pack_into(&mut market_info.try_borrow_mut_data()?)
}

fn process_claim(
    program_id: &Pubkey,
    accounts: &[AccountInfo],
    long_amount: u64,
    short_amount: u64,
) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let authority_info = next_account_info(it)?;
    let user_info = next_account_info(it)?;
    let user_long_info = next_account_info(it)?;
    let user_short_info = next_account_info(it)?;
    let long_mint_info = next_account_info(it)?;
    let short_mint_info = next_account_info(it)?;
    let vault_info = next_account_info(it)?;
    let user_coll_info = next_account_info(it)?;
    let collateral_mint_info = next_account_info(it)?;
    let collateral_tp_info = next_account_info(it)?;
    let tp_info = next_account_info(it)?;

    nonzero(
        long_amount
            .checked_add(short_amount)
            .ok_or(PairsError::Overflow)?,
    )?;
    require_signer(user_info)?;
    let ctx = Ctx::load(program_id, market_info, authority_info)?;
    if ctx.market.status == MarketStatus::Open {
        return Err(PairsError::NotSettled.into());
    }
    ctx.check_programs(collateral_tp_info, tp_info)?;
    ctx.check_mints(long_mint_info, short_mint_info)?;
    ctx.check_vault(vault_info)?;
    let decimals = ctx.collateral_decimals(collateral_mint_info)?;
    ctx.check_collateral_account(user_coll_info, Some(user_info.key))?;
    ctx.check_position_account(user_long_info, long_mint_info.key, user_info.key)?;
    ctx.check_position_account(user_short_info, short_mint_info.key, user_info.key)?;

    let long_ppm = ctx.market.long_payout_ppm;
    let total = math::payout(long_amount, long_ppm)?
        .checked_add(math::payout(short_amount, PRICE_SCALE - long_ppm)?)
        .ok_or(PairsError::Overflow)?;
    if long_amount > 0 {
        token::burn(
            tp_info,
            user_long_info,
            long_mint_info,
            user_info,
            long_amount,
        )?;
    }
    if short_amount > 0 {
        token::burn(
            tp_info,
            user_short_info,
            short_mint_info,
            user_info,
            short_amount,
        )?;
    }
    ctx.withdraw(
        collateral_tp_info,
        vault_info,
        collateral_mint_info,
        user_coll_info,
        total,
        decimals,
    )
}

fn process_crank(program_id: &Pubkey, accounts: &[AccountInfo], index_price: u64) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let settler_info = next_account_info(it)?;
    let mark_info = next_account_info(it).ok();

    if market_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    let market = Market::unpack(&market_info.try_borrow_data()?)?;
    let mut ctx = Ctx {
        market_info,
        bump: [market.bump],
        market,
        authority_info: market_info,
    };
    ctx.require_open()?;
    let price = ctx.index_price(settler_info, index_price)?;
    ctx.accrue_funding(price, current_slot()?, mark_info)?;
    ctx.save()
}

fn process_set_mark_whirlpool(program_id: &Pubkey, accounts: &[AccountInfo]) -> ProgramResult {
    let it = &mut accounts.iter();
    let market_info = next_account_info(it)?;
    let creator_info = next_account_info(it)?;
    let whirlpool_info = next_account_info(it)?;

    require_signer(creator_info)?;
    if market_info.owner != program_id {
        return Err(PairsError::IncorrectOwner.into());
    }
    let mut market = Market::unpack(&market_info.try_borrow_data()?)?;
    if market.status != MarketStatus::Open {
        return Err(PairsError::MarketNotOpen.into());
    }
    if *creator_info.key != market.creator {
        return Err(PairsError::MissingSignature.into());
    }
    if market.has_mark_whirlpool() {
        return Err(PairsError::AlreadyInUse.into());
    }
    let wp = read_whirlpool(whirlpool_info)?;
    market.mark_invert =
        if wp.token_mint_a == market.long_mint && wp.token_mint_b == market.collateral_mint {
            false
        } else if wp.token_mint_b == market.long_mint && wp.token_mint_a == market.collateral_mint {
            true
        } else {
            return Err(PairsError::InvalidWhirlpool.into());
        };
    market.mark_whirlpool = *whirlpool_info.key;
    market.pack_into(&mut market_info.try_borrow_mut_data()?)
}
