#!/usr/bin/env node
/**
 * deploy-testnet.js  —  Deploy thesis-rail-escrow to Stacks testnet
 *
 * Bypasses Clarinet's broken polling step on slow testnet nodes.
 *
 * Usage (from backend/contracts/):
 *   node deploy-testnet.js
 *
 * The private key is derived from the mnemonic in Testnet.toml.
 * To use a different wallet, set STX_PRIVATE_KEY env var.
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
    makeContractDeploy,
    broadcastTransaction,
    AnchorMode,
    PostConditionMode,
} from '@stacks/transactions';
import stacksNetworkPkg from '@stacks/network';
const { STACKS_TESTNET } = stacksNetworkPkg;

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────────────────────────────────────
// CONFIG — private key from Testnet.toml default deployer mnemonic
// To use your own wallet: STX_PRIVATE_KEY="your-private-key" node deploy-testnet.js
// ──────────────────────────────────────────────────────────────────────────────
// This is the STX private key derived from the Testnet.toml deployer mnemonic
// ("bring punch coach tunnel bridge about kick student uphold market arctic eyebrow...")
// Testnet address: ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM
const DEPLOYER_PRIVATE_KEY = process.env.STX_PRIVATE_KEY
    || 'd9f672e6d9e750965db64501afe283463d0ee314095ba2ba7e0ec95cfc9ca80801';

const DEPLOYER_ADDRESS = process.env.DEPLOYER_ADDRESS
    || 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM';

const CONTRACT_NAME = 'thesis-rail-escrow';
const CONTRACT_PATH = path.join(__dirname, 'contracts', `${CONTRACT_NAME}.clar`);
const CLARITY_VER = 3;
const FEE_USTX = 200_000n;    // 0.2 STX
const HIRO_TESTNET_API = 'https://api.testnet.hiro.so';

// ──────────────────────────────────────────────────────────────────────────────
// LOAD CONTRACT
// ──────────────────────────────────────────────────────────────────────────────
if (!fs.existsSync(CONTRACT_PATH)) {
    console.error(`❌  Contract file not found: ${CONTRACT_PATH}`);
    process.exit(1);
}
const codeBody = fs.readFileSync(CONTRACT_PATH, 'utf8');
console.log(`📄  Loaded: ${CONTRACT_NAME}.clar  (${codeBody.length.toLocaleString()} bytes)`);
console.log(`🔑  Deployer: ${DEPLOYER_ADDRESS}`);

// ──────────────────────────────────────────────────────────────────────────────
// FETCH NONCE & BALANCE
// ──────────────────────────────────────────────────────────────────────────────
const accResp = await fetch(`${HIRO_TESTNET_API}/v2/accounts/${DEPLOYER_ADDRESS}?proof=0`);
if (!accResp.ok) throw new Error(`Failed to fetch account: ${accResp.statusText}`);
const accData = await accResp.json();
const nonce = BigInt(accData.nonce);
const balanceMicro = BigInt(accData.balance);

console.log(`🔢  Nonce  : ${nonce}`);
console.log(`💰  Balance: ${(Number(balanceMicro) / 1_000_000).toFixed(6)} STX`);

if (balanceMicro < FEE_USTX) {
    console.error(`❌  Insufficient balance. Need ≥ ${Number(FEE_USTX) / 1e6} STX.`);
    console.error(`    Faucet: https://explorer.hiro.so/sandbox/faucet?chain=testnet`);
    process.exit(1);
}

// ──────────────────────────────────────────────────────────────────────────────
// BUILD & BROADCAST
// ──────────────────────────────────────────────────────────────────────────────
// @stacks/network v7: network is a plain object, pass it directly
const network = { ...STACKS_TESTNET, client: { baseUrl: HIRO_TESTNET_API } };

console.log('\n🔨  Building transaction...');
const tx = await makeContractDeploy({
    contractName: CONTRACT_NAME,
    codeBody,
    clarityVersion: CLARITY_VER,
    senderKey: DEPLOYER_PRIVATE_KEY,
    network,
    nonce,
    fee: FEE_USTX,
    anchorMode: AnchorMode.OnChainOnly,
    postConditionMode: PostConditionMode.Deny,
});

console.log('📡  Broadcasting...');
const result = await broadcastTransaction({ transaction: tx, url: `${HIRO_TESTNET_API}/v2/transactions` });

if (result.error) {
    console.error('\n❌  Broadcast error:', result.error);
    if (result.reason) console.error('    Reason:', result.reason);
    process.exit(1);
}

const txId = result.txid;
console.log('\n✅  Transaction submitted!');
console.log(`🆔  TXID   : 0x${txId}`);
console.log(`🔍  Track  : https://explorer.hiro.so/txid/0x${txId}?chain=testnet`);
console.log(`\n📦  Contract address (after ~2min):`);
console.log(`    ${DEPLOYER_ADDRESS}.${CONTRACT_NAME}`);
console.log(`\n🎉  Add to your frontend .env:`);
console.log(`    NEXT_PUBLIC_CONTRACT_ADDRESS=${DEPLOYER_ADDRESS}`);
console.log(`    NEXT_PUBLIC_CONTRACT_NAME=${CONTRACT_NAME}`);
