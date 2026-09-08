import { chromium } from 'playwright';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
const kp = Keypair.generate();
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
const errors = []; page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:3777/', { waitUntil: 'networkidle' });
await page.waitForSelector('#quoteRows .qrow', { timeout: 60000 });
await page.fill('#existingSecret', bs58.encode(kp.secretKey));
await page.click('#btnUseWallet');
await page.waitForSelector('#walletInfo:not(.hidden)');
const addr = await page.locator('#walletAddr').innerText();
console.log('derived pubkey matches:', addr === kp.publicKey.toBase58());
console.log('note:', await page.locator('#noSecret').innerText());
// JSON array form via the late prompt
await page.click('#btnForgetWallet');
await page.fill('#existingSecret', JSON.stringify(Array.from(kp.secretKey)));
await page.click('#btnUseWallet');
await page.waitForSelector('#walletInfo:not(.hidden)');
console.log('json form ok:', (await page.locator('#walletAddr').innerText()) === kp.publicKey.toBase58());
// reload keeps the secret (sessionStorage)
await page.reload({ waitUntil: 'networkidle' });
await page.waitForSelector('#walletInfo:not(.hidden)', { timeout: 60000 });
console.log('after reload note:', await page.locator('#noSecret').innerText());
console.log('errors', errors);
await browser.close();
