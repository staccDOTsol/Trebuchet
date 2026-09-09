//! End-to-end tests on the in-process Solana runtime (`solana-program-test`)
//! against the compiled SBF program. SPL Token, Token-2022 and the
//! Associated Token Account program are the real on-chain binaries bundled
//! with the test crate.
//!
//! Run with `cargo test-sbf` (from the Anza toolchain), which builds
//! `trebuchet_pairs.so` and points `SBF_OUT_DIR` at it. Native execution is
//! not supported: the `Clock`/`Rent` sysvar syscalls only exist inside the
//! SBF virtual machine with current `solana-*` crates.

use {
    solana_program::{instruction::Instruction, pubkey::Pubkey, rent::Rent},
    solana_program_test::{BanksClientError, ProgramTest, ProgramTestContext},
    solana_sdk::{
        account::{Account, AccountSharedData},
        instruction::InstructionError,
        signature::{Keypair, Signer},
        transaction::{Transaction, TransactionError},
    },
    solana_system_interface::instruction as system_instruction,
    trebuchet_pairs::{
        error::PairsError,
        instruction::{self as ix, InitMarketArgs},
        processor::{WHIRLPOOL_DISCRIMINATOR, WHIRLPOOL_PROGRAM_ID},
        state::{Market, MarketStatus, Offer, Side, PRICE_SCALE},
        token,
    },
};

const DECIMALS: u8 = 6;
const UNIT: u64 = 1_000_000;
const TRADE_END: u64 = 1_000;
const SETTLE_END: u64 = 2_000;

struct Env {
    ctx: ProgramTestContext,
    program_id: Pubkey,
}

impl Env {
    async fn new() -> Self {
        let program_id = trebuchet_pairs::id();
        assert!(
            std::env::var("SBF_OUT_DIR").is_ok() || std::env::var("BPF_OUT_DIR").is_ok(),
            "run these tests with `cargo test-sbf` so the compiled program is loaded"
        );
        let pt = ProgramTest::new("trebuchet_pairs", program_id, None);
        let ctx = pt.start_with_context().await;
        Env { ctx, program_id }
    }

    async fn send(
        &mut self,
        ixs: &[Instruction],
        signers: &[&Keypair],
    ) -> Result<(), BanksClientError> {
        let blockhash = self.ctx.get_new_latest_blockhash().await.unwrap();
        let payer = self.ctx.payer.insecure_clone();
        let mut all: Vec<&Keypair> = vec![&payer];
        all.extend_from_slice(signers);
        let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &all, blockhash);
        self.ctx.banks_client.process_transaction(tx).await
    }

    async fn fund(&mut self, to: &Pubkey, lamports: u64) {
        let payer = self.ctx.payer.pubkey();
        self.send(&[system_instruction::transfer(&payer, to, lamports)], &[])
            .await
            .unwrap();
    }

    async fn create_mint(&mut self, token_program: &Pubkey, authority: &Pubkey) -> Pubkey {
        let mint = Keypair::new();
        let rent = Rent::default().minimum_balance(token::MINT_LEN);
        let payer = self.ctx.payer.pubkey();
        self.send(
            &[
                system_instruction::create_account(
                    &payer,
                    &mint.pubkey(),
                    rent,
                    token::MINT_LEN as u64,
                    token_program,
                ),
                token::ix_initialize_mint2(
                    token_program,
                    &mint.pubkey(),
                    authority,
                    None,
                    DECIMALS,
                ),
            ],
            &[&mint],
        )
        .await
        .unwrap();
        mint.pubkey()
    }

    async fn create_ata(
        &mut self,
        owner: &Pubkey,
        mint: &Pubkey,
        token_program: &Pubkey,
    ) -> Pubkey {
        let payer = self.ctx.payer.pubkey();
        self.send(
            &[token::ix_create_associated_token_account_idempotent(
                &payer,
                owner,
                mint,
                token_program,
            )],
            &[],
        )
        .await
        .unwrap();
        token::associated_token_address(owner, mint, token_program)
    }

    async fn mint_collateral(
        &mut self,
        token_program: &Pubkey,
        mint: &Pubkey,
        to: &Pubkey,
        amount: u64,
    ) {
        let payer = self.ctx.payer.insecure_clone();
        self.send(
            &[token::ix_mint_to(
                token_program,
                mint,
                to,
                &payer.pubkey(),
                amount,
            )],
            &[],
        )
        .await
        .unwrap();
    }

    async fn account(&mut self, key: &Pubkey) -> Option<Account> {
        self.ctx.banks_client.get_account(*key).await.unwrap()
    }

    async fn balance(&mut self, token_account: &Pubkey) -> u64 {
        let a = self
            .account(token_account)
            .await
            .expect("token account exists");
        u64::from_le_bytes(a.data[64..72].try_into().unwrap())
    }

    async fn market(&mut self, key: &Pubkey) -> Market {
        Market::unpack(&self.account(key).await.unwrap().data).unwrap()
    }

    async fn offer(&mut self, key: &Pubkey) -> Option<Offer> {
        self.account(key)
            .await
            .map(|a| Offer::unpack(&a.data).unwrap())
    }

    async fn slot(&mut self) -> u64 {
        self.ctx.banks_client.get_root_slot().await.unwrap()
    }

    fn warp(&mut self, slot: u64) {
        self.ctx.warp_to_slot(slot).unwrap();
    }

    /// Install a fake Orca whirlpool account at `key` with the given price
    /// (`price` is B per A, already scaled by `10^DECIMALS`).
    fn set_whirlpool(&mut self, key: &Pubkey, mint_a: &Pubkey, mint_b: &Pubkey, price_scaled: u64) {
        let sqrt = ((price_scaled as f64 / 10f64.powi(DECIMALS as i32)).sqrt()
            * (1u128 << 64) as f64) as u128;
        let mut data = vec![0u8; 653];
        data[0..8].copy_from_slice(&WHIRLPOOL_DISCRIMINATOR);
        data[65..81].copy_from_slice(&sqrt.to_le_bytes());
        data[101..133].copy_from_slice(mint_a.as_ref());
        data[181..213].copy_from_slice(mint_b.as_ref());
        let acct = Account {
            lamports: 10_000_000,
            data,
            owner: WHIRLPOOL_PROGRAM_ID,
            executable: false,
            rent_epoch: 0,
        };
        self.ctx.set_account(key, &AccountSharedData::from(acct));
    }
}

fn custom_error(err: BanksClientError) -> Option<PairsError> {
    match err {
        BanksClientError::TransactionError(TransactionError::InstructionError(
            _,
            InstructionError::Custom(code),
        )) => {
            // Map back through the enum discriminants.
            let all = [
                PairsError::AlreadyInUse,
                PairsError::Uninitialized,
                PairsError::InvalidAuthority,
                PairsError::IncorrectOwner,
                PairsError::InvalidTokenProgram,
                PairsError::InvalidMint,
                PairsError::InvalidTokenAccount,
                PairsError::InvalidPositionMint,
                PairsError::ZeroAmount,
                PairsError::InvalidPrice,
                PairsError::InvalidRange,
                PairsError::InvalidSchedule,
                PairsError::TradingClosed,
                PairsError::MarketNotOpen,
                PairsError::NotSettled,
                PairsError::OutsideSettlementWindow,
                PairsError::WrongSettler,
                PairsError::MissingSignature,
                PairsError::InvalidWhirlpool,
                PairsError::Overflow,
                PairsError::TransferAmountMismatch,
                PairsError::OfferMarketMismatch,
                PairsError::OfferExpired,
                PairsError::OfferNotCancellable,
                PairsError::InvalidOfferAddress,
                PairsError::SelfTrade,
                PairsError::SameCounterparty,
                PairsError::InvalidPriceDecimals,
            ];
            all.get(code as usize).cloned()
        }
        _ => None,
    }
}

fn assert_pairs_err(res: Result<(), BanksClientError>, expected: PairsError) {
    match res {
        Ok(()) => panic!("expected {expected:?}, transaction succeeded"),
        Err(e) => {
            let got = custom_error(e);
            assert_eq!(got, Some(expected));
        }
    }
}

/// A user with collateral and position token accounts on one market.
struct User {
    kp: Keypair,
    collateral: Pubkey,
    long: Pubkey,
    short: Pubkey,
}

struct Fixture {
    market: Pubkey,
    creator: Keypair,
    creator_fee: Pubkey,
    settler: Keypair,
    collateral_mint: Pubkey,
    token_program: Pubkey,
    vault: Pubkey,
    long_mint: Pubkey,
    short_mint: Pubkey,
    underlying: Pubkey,
    whirlpool: Pubkey,
    users: Vec<User>,
}

impl Fixture {
    fn pair_accounts(&self, u: &User) -> ix::UserPairAccounts {
        ix::UserPairAccounts {
            market: self.market,
            user: u.kp.pubkey(),
            user_collateral: u.collateral,
            vault: self.vault,
            long_mint: self.long_mint,
            short_mint: self.short_mint,
            user_long: u.long,
            user_short: u.short,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.token_program,
        }
    }

    fn trade_accounts(&self, long: &User, short: &User) -> ix::TradeAccounts {
        ix::TradeAccounts {
            market: self.market,
            long_user: long.kp.pubkey(),
            short_user: short.kp.pubkey(),
            long_user_collateral: long.collateral,
            short_user_collateral: short.collateral,
            vault: self.vault,
            long_mint: self.long_mint,
            short_mint: self.short_mint,
            long_user_long: long.long,
            short_user_short: short.short,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.token_program,
            fee_account: self.creator_fee,
        }
    }

    fn place_accounts(&self, maker: &User) -> ix::PlaceOfferAccounts {
        ix::PlaceOfferAccounts {
            market: self.market,
            maker: maker.kp.pubkey(),
            maker_collateral: maker.collateral,
            vault: self.vault,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.token_program,
        }
    }

    fn fill_accounts(
        &self,
        offer: Pubkey,
        maker: &User,
        maker_side: Side,
        taker: &User,
    ) -> ix::FillOfferAccounts {
        let (maker_position, taker_position) = match maker_side {
            Side::Long => (maker.long, taker.short),
            Side::Short => (maker.short, taker.long),
        };
        ix::FillOfferAccounts {
            market: self.market,
            offer,
            maker: maker.kp.pubkey(),
            taker: taker.kp.pubkey(),
            taker_collateral: taker.collateral,
            vault: self.vault,
            long_mint: self.long_mint,
            short_mint: self.short_mint,
            maker_position,
            taker_position,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.token_program,
            fee_account: self.creator_fee,
        }
    }

    fn cancel_accounts(
        &self,
        offer: Pubkey,
        maker: &User,
        signer: &Pubkey,
    ) -> ix::CancelOfferAccounts {
        ix::CancelOfferAccounts {
            market: self.market,
            offer,
            maker: maker.kp.pubkey(),
            signer: *signer,
            maker_collateral: maker.collateral,
            vault: self.vault,
            collateral_mint: self.collateral_mint,
            collateral_token_program: self.token_program,
        }
    }
}

fn default_args(settle_kind: u8) -> InitMarketArgs {
    InitMarketArgs {
        settle_kind,
        invert: false,
        price_decimals: DECIMALS,
        // Range of ±10% around a spot of 1.000000 -> 5x at the midpoint.
        floor_price: 900_000,
        cap_price: 1_100_000,
        trade_end_slot: TRADE_END,
        settle_end_slot: SETTLE_END,
        funding_rate_ppm: 0,
        funding_period_slots: 0,
        max_funding_per_period_ppm: 0,
        taker_fee_ppm: 0,
    }
}

/// Build a market. `token_program` picks SPL Token or Token-2022 for the
/// collateral. Whirlpool mode installs a fake pool at `whirlpool` priced at
/// 1.000000 underlying/collateral.
async fn setup(env: &mut Env, token_program: Pubkey, args: InitMarketArgs) -> Fixture {
    let program_id = env.program_id;
    let creator = Keypair::new();
    let settler = Keypair::new();
    env.fund(&creator.pubkey(), 10_000_000_000).await;
    let payer = env.ctx.payer.pubkey();

    let collateral_mint = env.create_mint(&token_program, &payer).await;
    let underlying = env.create_mint(&token::TOKEN_PROGRAM_ID, &payer).await;
    let market_kp = Keypair::new();
    let market = market_kp.pubkey();
    let (authority, _) = ix::authority_address(&program_id, &market);
    let long_mint = env.create_mint(&token::TOKEN_PROGRAM_ID, &authority).await;
    let short_mint = env.create_mint(&token::TOKEN_PROGRAM_ID, &authority).await;
    let vault = env
        .create_ata(&authority, &collateral_mint, &token_program)
        .await;
    let creator_fee = env
        .create_ata(&creator.pubkey(), &collateral_mint, &token_program)
        .await;

    let whirlpool = Keypair::new().pubkey();
    let settler_key = if args.settle_kind == 1 {
        env.set_whirlpool(&whirlpool, &underlying, &collateral_mint, 1_000_000);
        whirlpool
    } else {
        settler.pubkey()
    };

    let rent = Rent::default().minimum_balance(Market::LEN);
    let init = ix::init_market(
        &program_id,
        &ix::InitMarketAccounts {
            market,
            creator: creator.pubkey(),
            collateral_mint,
            vault,
            long_mint,
            short_mint,
            settler: settler_key,
            underlying,
            collateral_token_program: token_program,
        },
        args,
    );
    env.send(
        &[
            system_instruction::create_account(
                &payer,
                &market,
                rent,
                Market::LEN as u64,
                &program_id,
            ),
            init,
        ],
        &[&market_kp, &creator],
    )
    .await
    .unwrap();

    let mut users = Vec::new();
    for _ in 0..3 {
        let kp = Keypair::new();
        env.fund(&kp.pubkey(), 5_000_000_000).await;
        let collateral = env
            .create_ata(&kp.pubkey(), &collateral_mint, &token_program)
            .await;
        let long = env
            .create_ata(&kp.pubkey(), &long_mint, &token::TOKEN_PROGRAM_ID)
            .await;
        let short = env
            .create_ata(&kp.pubkey(), &short_mint, &token::TOKEN_PROGRAM_ID)
            .await;
        env.mint_collateral(&token_program, &collateral_mint, &collateral, 100 * UNIT)
            .await;
        users.push(User {
            kp,
            collateral,
            long,
            short,
        });
    }

    Fixture {
        market,
        creator,
        creator_fee,
        settler,
        collateral_mint,
        token_program,
        vault,
        long_mint,
        short_mint,
        underlying,
        whirlpool,
        users,
    }
}

// ---------------------------------------------------------------------------

#[tokio::test]
async fn full_lifecycle_authority_settlement() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let m = env.market(&f.market).await;
    assert_eq!(m.status, MarketStatus::Open);
    assert_eq!(m.creator, f.creator.pubkey());
    assert_eq!(m.settler, f.settler.pubkey());

    let a = &f.users[0];
    let b = &f.users[1];

    // Mint 10 pairs, redeem 4.
    env.send(
        &[ix::mint_pairs(&pid, &f.pair_accounts(a), 10 * UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.long).await, 10 * UNIT);
    assert_eq!(env.balance(&a.short).await, 10 * UNIT);
    assert_eq!(env.balance(&a.collateral).await, 90 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 10 * UNIT);
    env.send(
        &[ix::redeem_pairs(&pid, &f.pair_accounts(a), 4 * UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.long).await, 6 * UNIT);
    assert_eq!(env.balance(&a.collateral).await, 94 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 6 * UNIT);

    // A goes long 20 contracts vs B at 25%: A pays 5, B pays 15.
    env.send(
        &[ix::trade(&pid, &f.trade_accounts(a, b), 20 * UNIT, 250_000)],
        &[&a.kp, &b.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.collateral).await, 89 * UNIT);
    assert_eq!(env.balance(&b.collateral).await, 85 * UNIT);
    assert_eq!(env.balance(&a.long).await, 26 * UNIT);
    assert_eq!(env.balance(&b.short).await, 20 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 26 * UNIT);
    let m = env.market(&f.market).await;
    assert_eq!(m.vwap_den, 20 * UNIT);
    assert_eq!(m.vwap_num, 20 * UNIT as u128 * 250_000);

    // Too early to settle, settler must sign, wrong settler rejected.
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                true,
                None,
                1_050_000,
            )],
            &[&f.settler],
        )
        .await,
        PairsError::OutsideSettlementWindow,
    );
    env.warp(TRADE_END);
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                false,
                None,
                1_050_000,
            )],
            &[],
        )
        .await,
        PairsError::MissingSignature,
    );
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &a.kp.pubkey(),
                true,
                None,
                1_050_000,
            )],
            &[&a.kp],
        )
        .await,
        PairsError::WrongSettler,
    );
    // Trading is closed now.
    assert_pairs_err(
        env.send(&[ix::mint_pairs(&pid, &f.pair_accounts(a), UNIT)], &[&a.kp])
            .await,
        PairsError::TradingClosed,
    );
    assert_pairs_err(
        env.send(&[ix::claim(&pid, &f.pair_accounts(a), UNIT, 0)], &[&a.kp])
            .await,
        PairsError::NotSettled,
    );
    // Redeeming pairs is still fine while open.
    env.send(
        &[ix::redeem_pairs(&pid, &f.pair_accounts(a), UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();

    // Settle at +5% -> long pays out 75%.
    env.send(
        &[ix::settle(
            &pid,
            &f.market,
            &f.settler.pubkey(),
            true,
            None,
            1_050_000,
        )],
        &[&f.settler],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert_eq!(m.status, MarketStatus::Settled);
    assert_eq!(m.settlement_price, 1_050_000);
    assert_eq!(m.long_payout_ppm, 750_000);
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                true,
                None,
                1,
            )],
            &[&f.settler],
        )
        .await,
        PairsError::MarketNotOpen,
    );
    assert_pairs_err(
        env.send(
            &[ix::redeem_pairs(&pid, &f.pair_accounts(a), UNIT)],
            &[&a.kp],
        )
        .await,
        PairsError::MarketNotOpen,
    );

    // A: 25 LONG + 5 SHORT -> 25*0.75 + 5*0.25 = 20. B: 20 SHORT -> 5.
    let a_before = env.balance(&a.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(a), 25 * UNIT, 5 * UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.collateral).await - a_before, 20 * UNIT);
    let b_before = env.balance(&b.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(b), 0, 20 * UNIT)],
        &[&b.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&b.collateral).await - b_before, 5 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 0);
    assert_eq!(env.balance(&a.long).await, 0);
    assert_eq!(env.balance(&b.short).await, 0);
}

#[tokio::test]
async fn resting_offers_fill_partially_and_close() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let maker = &f.users[0];
    let taker = &f.users[1];
    let other = &f.users[2];

    // Maker wants SHORT on 10 contracts at long price 30% -> escrows 7.
    let (offer, _) = ix::offer_address(&pid, &f.market, &maker.kp.pubkey(), 1);
    env.send(
        &[ix::place_offer(
            &pid,
            &f.place_accounts(maker),
            1,
            300_000,
            10 * UNIT,
            0,
            1,
        )],
        &[&maker.kp],
    )
    .await
    .unwrap();
    let o = env.offer(&offer).await.unwrap();
    assert_eq!(o.side, Side::Short);
    assert_eq!(o.remaining, 10 * UNIT);
    assert_eq!(o.escrowed, 7 * UNIT);
    assert_eq!(env.balance(&maker.collateral).await, 93 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 7 * UNIT);

    // Same nonce cannot be reused.
    assert_pairs_err(
        env.send(
            &[ix::place_offer(
                &pid,
                &f.place_accounts(maker),
                1,
                300_000,
                UNIT,
                0,
                1,
            )],
            &[&maker.kp],
        )
        .await,
        PairsError::AlreadyInUse,
    );
    // Maker cannot fill their own offer.
    assert_pairs_err(
        env.send(
            &[ix::fill_offer(
                &pid,
                &f.fill_accounts(offer, maker, Side::Short, maker),
                UNIT,
            )],
            &[&maker.kp],
        )
        .await,
        PairsError::SelfTrade,
    );

    // Taker takes 4: maker share floor(7*4/10) = 2.8, taker pays 1.2.
    env.send(
        &[ix::fill_offer(
            &pid,
            &f.fill_accounts(offer, maker, Side::Short, taker),
            4 * UNIT,
        )],
        &[&taker.kp],
    )
    .await
    .unwrap();
    let o = env.offer(&offer).await.unwrap();
    assert_eq!(o.remaining, 6 * UNIT);
    assert_eq!(o.escrowed, 4_200_000);
    assert_eq!(env.balance(&taker.collateral).await, 100 * UNIT - 1_200_000);
    assert_eq!(env.balance(&taker.long).await, 4 * UNIT);
    assert_eq!(env.balance(&maker.short).await, 4 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 7 * UNIT + 1_200_000);

    // Asking for more than remaining fills the rest and closes the offer.
    let rent_before = env.account(&maker.kp.pubkey()).await.unwrap().lamports;
    env.send(
        &[ix::fill_offer(
            &pid,
            &f.fill_accounts(offer, maker, Side::Short, other),
            100 * UNIT,
        )],
        &[&other.kp],
    )
    .await
    .unwrap();
    assert!(env.offer(&offer).await.is_none(), "offer account closed");
    assert!(
        env.account(&maker.kp.pubkey()).await.unwrap().lamports > rent_before,
        "rent refunded"
    );
    assert_eq!(env.balance(&other.collateral).await, 100 * UNIT - 1_800_000);
    assert_eq!(env.balance(&other.long).await, 6 * UNIT);
    assert_eq!(env.balance(&maker.short).await, 10 * UNIT);
    // Vault holds exactly the backing for 10 pairs.
    assert_eq!(env.balance(&f.vault).await, 10 * UNIT);

    // Everyone can unwind by trading the opposite side and redeeming.
    env.send(
        &[ix::trade(
            &pid,
            &f.trade_accounts(maker, taker),
            4 * UNIT,
            500_000,
        )],
        &[&maker.kp, &taker.kp],
    )
    .await
    .unwrap();
    env.send(
        &[ix::redeem_pairs(&pid, &f.pair_accounts(maker), 4 * UNIT)],
        &[&maker.kp],
    )
    .await
    .unwrap();
    env.send(
        &[ix::redeem_pairs(&pid, &f.pair_accounts(taker), 4 * UNIT)],
        &[&taker.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&f.vault).await, 6 * UNIT);
}

#[tokio::test]
async fn offers_cancel_and_expire() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let maker = &f.users[0];
    let stranger = &f.users[1];

    // LONG offer, expires at slot 500.
    let (offer, _) = ix::offer_address(&pid, &f.market, &maker.kp.pubkey(), 9);
    env.send(
        &[ix::place_offer(
            &pid,
            &f.place_accounts(maker),
            0,
            400_000,
            5 * UNIT,
            500,
            9,
        )],
        &[&maker.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.offer(&offer).await.unwrap().escrowed, 2 * UNIT);

    // A stranger cannot cancel a live offer.
    assert_pairs_err(
        env.send(
            &[ix::cancel_offer(
                &pid,
                &f.cancel_accounts(offer, maker, &stranger.kp.pubkey()),
            )],
            &[&stranger.kp],
        )
        .await,
        PairsError::OfferNotCancellable,
    );
    // Expired offers cannot be filled but anyone can sweep them back to the maker.
    env.warp(501);
    assert_pairs_err(
        env.send(
            &[ix::fill_offer(
                &pid,
                &f.fill_accounts(offer, maker, Side::Long, stranger),
                UNIT,
            )],
            &[&stranger.kp],
        )
        .await,
        PairsError::OfferExpired,
    );
    env.send(
        &[ix::cancel_offer(
            &pid,
            &f.cancel_accounts(offer, maker, &stranger.kp.pubkey()),
        )],
        &[&stranger.kp],
    )
    .await
    .unwrap();
    assert!(env.offer(&offer).await.is_none());
    assert_eq!(env.balance(&maker.collateral).await, 100 * UNIT);
    assert_eq!(env.balance(&f.vault).await, 0);

    // Maker cancels their own live offer immediately.
    let (offer2, _) = ix::offer_address(&pid, &f.market, &maker.kp.pubkey(), 10);
    env.send(
        &[ix::place_offer(
            &pid,
            &f.place_accounts(maker),
            1,
            400_000,
            5 * UNIT,
            0,
            10,
        )],
        &[&maker.kp],
    )
    .await
    .unwrap();
    env.send(
        &[ix::cancel_offer(
            &pid,
            &f.cancel_accounts(offer2, maker, &maker.kp.pubkey()),
        )],
        &[&maker.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&maker.collateral).await, 100 * UNIT);

    // Offers cannot be placed with an expiry in the past, a zero size, or a bad price.
    assert_pairs_err(
        env.send(
            &[ix::place_offer(
                &pid,
                &f.place_accounts(maker),
                1,
                400_000,
                UNIT,
                100,
                11,
            )],
            &[&maker.kp],
        )
        .await,
        PairsError::OfferExpired,
    );
    assert_pairs_err(
        env.send(
            &[ix::place_offer(
                &pid,
                &f.place_accounts(maker),
                1,
                400_000,
                0,
                0,
                11,
            )],
            &[&maker.kp],
        )
        .await,
        PairsError::ZeroAmount,
    );
    assert_pairs_err(
        env.send(
            &[ix::place_offer(
                &pid,
                &f.place_accounts(maker),
                1,
                PRICE_SCALE,
                UNIT,
                0,
                11,
            )],
            &[&maker.kp],
        )
        .await,
        PairsError::InvalidPrice,
    );
}

#[tokio::test]
async fn whirlpool_settlement_with_funding() {
    let mut env = Env::new().await;
    let mut args = default_args(1);
    // 100% of the premium per 100-slot period, capped at 5% of notional per period.
    args.funding_rate_ppm = PRICE_SCALE;
    args.funding_period_slots = 100;
    args.max_funding_per_period_ppm = 50_000;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, args).await;
    let pid = env.program_id;
    let a = &f.users[0];
    let b = &f.users[1];
    let m = env.market(&f.market).await;
    assert_eq!(m.settler, f.whirlpool);
    let start = m.last_crank_slot;

    // Longs are paying 90% for a contract whose fair value at spot is 50%.
    env.send(
        &[ix::trade(&pid, &f.trade_accounts(a, b), 10 * UNIT, 900_000)],
        &[&a.kp, &b.kp],
    )
    .await
    .unwrap();
    // A whole period later anyone cranks: premium 0.4 * 100% = 0.4, capped at 0.05.
    env.warp(start + 100);
    env.send(
        &[ix::crank(&pid, &f.market, &f.whirlpool, false, None, 0)],
        &[],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert_eq!(m.funding_offset_ppm, 50_000);
    assert_eq!(m.last_index_price, 1_000_000);
    assert_eq!(m.vwap_den, 0);
    // Cranking again in the same slot is a no-op.
    env.send(
        &[ix::crank(&pid, &f.market, &f.whirlpool, false, None, 0)],
        &[],
    )
    .await
    .unwrap();
    assert_eq!(env.market(&f.market).await.funding_offset_ppm, 50_000);

    // Half a period later with no trades: nothing accrues, clock advances.
    env.warp(start + 150);
    env.send(
        &[ix::crank(&pid, &f.market, &f.whirlpool, false, None, 0)],
        &[],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert_eq!(m.funding_offset_ppm, 50_000);
    assert_eq!(m.last_crank_slot, start + 150);

    // Price rallies to 1.05 -> intrinsic 75%; permissionless settlement.
    env.set_whirlpool(&f.whirlpool, &f.underlying, &f.collateral_mint, 1_050_000);
    env.warp(TRADE_END);
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                false,
                None,
                0,
            )],
            &[],
        )
        .await,
        PairsError::WrongSettler,
    );
    env.send(
        &[ix::settle(&pid, &f.market, &f.whirlpool, false, None, 0)],
        &[],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert_eq!(m.status, MarketStatus::Settled);
    assert!(
        (m.settlement_price as i64 - 1_050_000).abs() <= 1,
        "{}",
        m.settlement_price
    );
    // 75% intrinsic minus 5% funding paid by longs.
    assert!(
        (m.long_payout_ppm as i64 - 700_000).abs() <= 5,
        "{}",
        m.long_payout_ppm
    );

    let a_before = env.balance(&a.collateral).await;
    let b_before = env.balance(&b.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(a), 10 * UNIT, 0)],
        &[&a.kp],
    )
    .await
    .unwrap();
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(b), 0, 10 * UNIT)],
        &[&b.kp],
    )
    .await
    .unwrap();
    let a_got = env.balance(&a.collateral).await - a_before;
    let b_got = env.balance(&b.collateral).await - b_before;
    assert!(a_got.abs_diff(7 * UNIT) <= 50, "{a_got}");
    assert!(b_got.abs_diff(3 * UNIT) <= 50, "{b_got}");
    assert!(a_got + b_got <= 10 * UNIT);
    assert!(env.balance(&f.vault).await <= 1);
}

#[tokio::test]
async fn whirlpool_mark_source_drives_funding() {
    let mut env = Env::new().await;
    let mut args = default_args(0);
    args.funding_rate_ppm = 2 * PRICE_SCALE; // 200% of premium per period
    args.funding_period_slots = 100;
    args.max_funding_per_period_ppm = PRICE_SCALE;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, args).await;
    let pid = env.program_id;
    let start = env.market(&f.market).await.last_crank_slot;

    // A LONG/collateral pool trading LONG at 0.30 while the index says 0.50.
    let mark_pool = Keypair::new().pubkey();
    env.set_whirlpool(&mark_pool, &f.long_mint, &f.collateral_mint, 300_000);
    // Only the creator may set it, and only once.
    assert_pairs_err(
        env.send(
            &[ix::set_mark_whirlpool(
                &pid,
                &f.market,
                &f.users[0].kp.pubkey(),
                &mark_pool,
            )],
            &[&f.users[0].kp],
        )
        .await,
        PairsError::MissingSignature,
    );
    env.send(
        &[ix::set_mark_whirlpool(
            &pid,
            &f.market,
            &f.creator.pubkey(),
            &mark_pool,
        )],
        &[&f.creator],
    )
    .await
    .unwrap();
    assert_pairs_err(
        env.send(
            &[ix::set_mark_whirlpool(
                &pid,
                &f.market,
                &f.creator.pubkey(),
                &mark_pool,
            )],
            &[&f.creator],
        )
        .await,
        PairsError::AlreadyInUse,
    );
    let m = env.market(&f.market).await;
    assert_eq!(m.mark_whirlpool, mark_pool);
    assert!(!m.mark_invert);

    // Crank must now carry the mark pool. Premium -0.2 * 200% = -0.4 per period; half a period -> -0.2.
    env.warp(start + 50);
    assert!(env
        .send(
            &[ix::crank(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                true,
                None,
                1_000_000
            )],
            &[&f.settler]
        )
        .await
        .is_err());
    env.send(
        &[ix::crank(
            &pid,
            &f.market,
            &f.settler.pubkey(),
            true,
            Some(&mark_pool),
            1_000_000,
        )],
        &[&f.settler],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert!(
        (m.funding_offset_ppm + 200_000).abs() <= 5,
        "{}",
        m.funding_offset_ppm
    );

    // Settlement accrues funding one last time; park the mark at fair value
    // so that final accrual is zero, then settle at spot (50%): longs get
    // 50% + the 20% shorts paid them = 70%.
    env.set_whirlpool(&mark_pool, &f.long_mint, &f.collateral_mint, 500_000);
    env.warp(TRADE_END);
    env.send(
        &[ix::settle(
            &pid,
            &f.market,
            &f.settler.pubkey(),
            true,
            Some(&mark_pool),
            1_000_000,
        )],
        &[&f.settler],
    )
    .await
    .unwrap();
    let m = env.market(&f.market).await;
    assert!(
        (m.long_payout_ppm as i64 - 700_000).abs() <= 5,
        "{}",
        m.long_payout_ppm
    );
}

#[tokio::test]
async fn void_when_nobody_settles() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let a = &f.users[0];
    let b = &f.users[1];
    env.send(
        &[ix::trade(&pid, &f.trade_accounts(a, b), 8 * UNIT, 100_000)],
        &[&a.kp, &b.kp],
    )
    .await
    .unwrap();

    env.warp(TRADE_END + 1);
    assert_pairs_err(
        env.send(&[ix::void(&pid, &f.market)], &[]).await,
        PairsError::OutsideSettlementWindow,
    );
    env.warp(SETTLE_END + 1);
    assert_pairs_err(
        env.send(
            &[ix::settle(
                &pid,
                &f.market,
                &f.settler.pubkey(),
                true,
                None,
                1_000_000,
            )],
            &[&f.settler],
        )
        .await,
        PairsError::OutsideSettlementWindow,
    );
    env.send(&[ix::void(&pid, &f.market)], &[]).await.unwrap();
    let m = env.market(&f.market).await;
    assert_eq!(m.status, MarketStatus::Void);
    assert_eq!(m.long_payout_ppm, PRICE_SCALE / 2);

    let a_before = env.balance(&a.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(a), 8 * UNIT, 0)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.collateral).await - a_before, 4 * UNIT);
    let b_before = env.balance(&b.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(b), 0, 8 * UNIT)],
        &[&b.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&b.collateral).await - b_before, 4 * UNIT);
}

#[tokio::test]
async fn taker_fees_go_to_creator() {
    let mut env = Env::new().await;
    let mut args = default_args(0);
    args.taker_fee_ppm = 1_000; // 0.1%
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, args).await;
    let pid = env.program_id;
    let a = &f.users[0];
    let b = &f.users[1];

    // Direct trade: both sides pay 0.1% of 10 = 0.01 each.
    env.send(
        &[ix::trade(&pid, &f.trade_accounts(a, b), 10 * UNIT, 500_000)],
        &[&a.kp, &b.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&f.creator_fee).await, 20_000);
    assert_eq!(env.balance(&a.collateral).await, 95 * UNIT - 10_000);

    // Offer: maker is fee-free, taker pays on the filled notional.
    let (offer, _) = ix::offer_address(&pid, &f.market, &a.kp.pubkey(), 1);
    env.send(
        &[ix::place_offer(
            &pid,
            &f.place_accounts(a),
            0,
            500_000,
            4 * UNIT,
            0,
            1,
        )],
        &[&a.kp],
    )
    .await
    .unwrap();
    let b_before = env.balance(&b.collateral).await;
    env.send(
        &[ix::fill_offer(
            &pid,
            &f.fill_accounts(offer, a, Side::Long, b),
            4 * UNIT,
        )],
        &[&b.kp],
    )
    .await
    .unwrap();
    assert_eq!(
        b_before - env.balance(&b.collateral).await,
        2 * UNIT + 4_000
    );
    assert_eq!(env.balance(&f.creator_fee).await, 24_000);

    // The fee account must belong to the creator.
    let wrong = ix::TradeAccounts {
        fee_account: b.collateral,
        ..f.trade_accounts(a, b)
    };
    assert_pairs_err(
        env.send(&[ix::trade(&pid, &wrong, UNIT, 500_000)], &[&a.kp, &b.kp])
            .await,
        PairsError::InvalidTokenAccount,
    );
}

#[tokio::test]
async fn token_2022_collateral() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_2022_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let a = &f.users[0];
    let b = &f.users[1];
    assert_eq!(
        env.market(&f.market).await.collateral_token_program,
        token::TOKEN_2022_PROGRAM_ID
    );

    env.send(
        &[ix::mint_pairs(&pid, &f.pair_accounts(a), 3 * UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();
    env.send(
        &[ix::trade(&pid, &f.trade_accounts(a, b), 2 * UNIT, 750_000)],
        &[&a.kp, &b.kp],
    )
    .await
    .unwrap();
    assert_eq!(
        env.balance(&a.collateral).await,
        100 * UNIT - 3 * UNIT - 1_500_000
    );
    assert_eq!(env.balance(&b.collateral).await, 100 * UNIT - 500_000);
    env.send(
        &[ix::redeem_pairs(&pid, &f.pair_accounts(a), 3 * UNIT)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&f.vault).await, 2 * UNIT);

    env.warp(TRADE_END);
    env.send(
        &[ix::settle(
            &pid,
            &f.market,
            &f.settler.pubkey(),
            true,
            None,
            2_000_000,
        )],
        &[&f.settler],
    )
    .await
    .unwrap();
    assert_eq!(env.market(&f.market).await.long_payout_ppm, PRICE_SCALE);
    let a_before = env.balance(&a.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(a), 2 * UNIT, 0)],
        &[&a.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&a.collateral).await - a_before, 2 * UNIT);
    let b_before = env.balance(&b.collateral).await;
    env.send(
        &[ix::claim(&pid, &f.pair_accounts(b), 0, 2 * UNIT)],
        &[&b.kp],
    )
    .await
    .unwrap();
    assert_eq!(env.balance(&b.collateral).await - b_before, 0);
}

#[tokio::test]
async fn guards() {
    let mut env = Env::new().await;
    let f = setup(&mut env, token::TOKEN_PROGRAM_ID, default_args(0)).await;
    let pid = env.program_id;
    let a = &f.users[0];
    let b = &f.users[1];

    assert_pairs_err(
        env.send(&[ix::mint_pairs(&pid, &f.pair_accounts(a), 0)], &[&a.kp])
            .await,
        PairsError::ZeroAmount,
    );
    assert_pairs_err(
        env.send(
            &[ix::trade(&pid, &f.trade_accounts(a, b), UNIT, 0)],
            &[&a.kp, &b.kp],
        )
        .await,
        PairsError::InvalidPrice,
    );
    assert_pairs_err(
        env.send(
            &[ix::trade(&pid, &f.trade_accounts(a, a), UNIT, 500_000)],
            &[&a.kp],
        )
        .await,
        PairsError::SameCounterparty,
    );
    // Position accounts must belong to the user.
    let stolen = ix::UserPairAccounts {
        user_long: b.long,
        ..f.pair_accounts(a)
    };
    assert_pairs_err(
        env.send(&[ix::mint_pairs(&pid, &stolen, UNIT)], &[&a.kp])
            .await,
        PairsError::InvalidTokenAccount,
    );
    // A collateral account with the wrong mint is rejected.
    let wrong_mint = ix::UserPairAccounts {
        user_collateral: a.long,
        ..f.pair_accounts(a)
    };
    assert_pairs_err(
        env.send(&[ix::mint_pairs(&pid, &wrong_mint, UNIT)], &[&a.kp])
            .await,
        PairsError::InvalidTokenAccount,
    );
    // Redeeming more than held fails inside the token program.
    assert!(env
        .send(
            &[ix::redeem_pairs(&pid, &f.pair_accounts(a), UNIT)],
            &[&a.kp]
        )
        .await
        .is_err());

    // Bad market parameters.
    let payer = env.ctx.payer.pubkey();
    let mk = Keypair::new();
    let (authority, _) = ix::authority_address(&pid, &mk.pubkey());
    let lm = env.create_mint(&token::TOKEN_PROGRAM_ID, &authority).await;
    let sm = env.create_mint(&token::TOKEN_PROGRAM_ID, &authority).await;
    let vault = env
        .create_ata(&authority, &f.collateral_mint, &token::TOKEN_PROGRAM_ID)
        .await;
    let accounts = ix::InitMarketAccounts {
        market: mk.pubkey(),
        creator: f.creator.pubkey(),
        collateral_mint: f.collateral_mint,
        vault,
        long_mint: lm,
        short_mint: sm,
        settler: f.settler.pubkey(),
        underlying: f.underlying,
        collateral_token_program: token::TOKEN_PROGRAM_ID,
    };
    let rent = Rent::default().minimum_balance(Market::LEN);
    let create =
        system_instruction::create_account(&payer, &mk.pubkey(), rent, Market::LEN as u64, &pid);
    let mut bad = default_args(0);
    bad.floor_price = bad.cap_price;
    assert_pairs_err(
        env.send(
            &[create.clone(), ix::init_market(&pid, &accounts, bad)],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidRange,
    );
    let mut bad = default_args(0);
    bad.settle_end_slot = bad.trade_end_slot;
    assert_pairs_err(
        env.send(
            &[create.clone(), ix::init_market(&pid, &accounts, bad)],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidSchedule,
    );
    let mut bad = default_args(0);
    bad.funding_rate_ppm = 1;
    assert_pairs_err(
        env.send(
            &[create.clone(), ix::init_market(&pid, &accounts, bad)],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidSchedule,
    );
    let mut bad = default_args(0);
    bad.taker_fee_ppm = 200_000;
    assert_pairs_err(
        env.send(
            &[create.clone(), ix::init_market(&pid, &accounts, bad)],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidPrice,
    );
    // Position mints whose authority is not the PDA are rejected.
    let rogue = env.create_mint(&token::TOKEN_PROGRAM_ID, &payer).await;
    let rogue_accounts = ix::InitMarketAccounts {
        long_mint: rogue,
        ..accounts
    };
    assert_pairs_err(
        env.send(
            &[
                create.clone(),
                ix::init_market(&pid, &rogue_accounts, default_args(0)),
            ],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidPositionMint,
    );
    // Whirlpool mode with a settler that is not a whirlpool.
    let wp_accounts = ix::InitMarketAccounts {
        settler: f.settler.pubkey(),
        ..accounts
    };
    assert_pairs_err(
        env.send(
            &[create, ix::init_market(&pid, &wp_accounts, default_args(1))],
            &[&mk, &f.creator],
        )
        .await,
        PairsError::InvalidWhirlpool,
    );
    let _ = env.slot().await;
}
