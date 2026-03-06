#!/usr/bin/env node
/**
 * deploy-testnet.js - Deploy thesis-rail-escrow-v7 to Stacks testnet.
 *
 * Usage (from backend/contracts):
 *   STX_PRIVATE_KEY="..." node deploy-testnet.js
 *
 * Optional:
 *   DEPLOYER_ADDRESS="ST..." STX_PRIVATE_KEY="..." node deploy-testnet.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  makeContractDeploy,
  broadcastTransaction,
  AnchorMode,
  PostConditionMode,
  privateKeyToAddress,
} from '@stacks/transactions';
import stacksNetworkPkg from '@stacks/network';

const { STACKS_TESTNET } = stacksNetworkPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEPLOYER_PRIVATE_KEY = process.env.STX_PRIVATE_KEY;
if (!DEPLOYER_PRIVATE_KEY) {
  console.error('Missing STX_PRIVATE_KEY env var.');
  process.exit(1);
}

const DEPLOYER_ADDRESS =
  process.env.DEPLOYER_ADDRESS || privateKeyToAddress(DEPLOYER_PRIVATE_KEY, 'testnet');

const CONTRACT_FILE = process.env.CONTRACT_FILE || 'thesis-rail-escrow-v7';
const CONTRACT_NAME = process.env.CONTRACT_NAME || CONTRACT_FILE;
const CONTRACT_PATH = path.join(__dirname, 'contracts', `${CONTRACT_FILE}.clar`);
const CLARITY_VER = 4;
const FEE_USTX = 200_000n; // 0.2 STX
const HIRO_TESTNET_API = 'https://api.testnet.hiro.so';

if (!fs.existsSync(CONTRACT_PATH)) {
  console.error(`Contract file not found: ${CONTRACT_PATH}`);
  process.exit(1);
}

const codeBody = fs.readFileSync(CONTRACT_PATH, 'utf8');
console.log(`Loaded ${CONTRACT_FILE}.clar (${codeBody.length.toLocaleString()} bytes)`);
console.log(`Deployer: ${DEPLOYER_ADDRESS}`);
console.log(`Clarity version: ${CLARITY_VER}`);

const accResp = await fetch(`${HIRO_TESTNET_API}/v2/accounts/${DEPLOYER_ADDRESS}?proof=0`);
if (!accResp.ok) {
  throw new Error(`Failed to fetch account: ${accResp.status} ${accResp.statusText}`);
}

const accData = await accResp.json();
const nonce = BigInt(accData.nonce);
const balanceMicro = BigInt(accData.balance);

console.log(`Nonce: ${nonce}`);
console.log(`Balance: ${(Number(balanceMicro) / 1_000_000).toFixed(6)} STX`);

if (balanceMicro < FEE_USTX) {
  console.error(`Insufficient balance. Need >= ${Number(FEE_USTX) / 1e6} STX.`);
  console.error('Faucet: https://explorer.hiro.so/sandbox/faucet?chain=testnet');
  process.exit(1);
}

const network = { ...STACKS_TESTNET, client: { baseUrl: HIRO_TESTNET_API } };

console.log('Building transaction...');
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

console.log('Broadcasting...');
const result = await broadcastTransaction({
  transaction: tx,
  url: `${HIRO_TESTNET_API}/v2/transactions`,
});

if (result.error) {
  console.error('Broadcast error:', result.error);
  if (result.reason) {
    console.error('Reason:', result.reason);
  }
  process.exit(1);
}

const txId = result.txid;
console.log('Transaction submitted.');
console.log(`TXID: 0x${txId}`);
console.log(`Track: https://explorer.hiro.so/txid/0x${txId}?chain=testnet`);
console.log('Contract principal (after confirmation):');
console.log(`${DEPLOYER_ADDRESS}.${CONTRACT_NAME}`);
console.log('Frontend env values:');
console.log(`NEXT_PUBLIC_CONTRACT_ADDRESS=${DEPLOYER_ADDRESS}`);
console.log(`NEXT_PUBLIC_CONTRACT_NAME=${CONTRACT_NAME}`);
