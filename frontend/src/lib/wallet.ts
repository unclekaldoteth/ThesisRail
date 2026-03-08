/**
 * Stacks Wallet Integration
 * Wraps @stacks/connect for wallet connection and contract interactions.
 */

import { request, connect, isConnected, disconnect, getLocalStorage } from '@stacks/connect';
import type { AddressString, AssetString, ContractIdString } from '@stacks/transactions';
import {
    bufferCV,
    ClarityValue,
    contractPrincipalCV,
    cvToValue,
    hexToCV,
    noneCV,
    Pc,
    postConditionToHex,
    serializeCV,
    someCV,
    standardPrincipalCV,
    uintCV,
} from '@stacks/transactions';
import { hexToBytes } from '@stacks/common';

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM';
const CONTRACT_NAME = process.env.NEXT_PUBLIC_CONTRACT_NAME || 'thesis-rail-escrow-v7';
const CONTRACT_ID = `${CONTRACT_ADDRESS}.${CONTRACT_NAME}` as ContractIdString;
const NETWORK_ID = process.env.NEXT_PUBLIC_NETWORK || 'testnet';
const STACKS_API_BASE_URL = (
    process.env.NEXT_PUBLIC_STACKS_API_URL ||
    (NETWORK_ID === 'mainnet' ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so')
).replace(/\/$/, '');
const USDCX_CONTRACT_ID = (process.env.NEXT_PUBLIC_USDCX_CONTRACT_ID || (
    NETWORK_ID === 'mainnet'
        ? 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx'
        : 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx'
 )) as ContractIdString;

function splitContractId(contractId: string): { address: string; name: string } {
    const [address, ...parts] = contractId.split('.');
    const name = parts.join('.');
    if (!address || !name) {
        throw new Error(`Invalid contract id: ${contractId}`);
    }
    return { address, name };
}

const USDCX_CONTRACT = splitContractId(USDCX_CONTRACT_ID);
const DEFAULT_USDCX_ASSET_NAME = process.env.NEXT_PUBLIC_USDCX_ASSET_NAME?.trim() || 'usdcx-token';

export interface WalletState {
    isConnected: boolean;
    address: string | null;
}

export type TxWaitOutcome = 'success' | 'failed' | 'pending';

function serializeArg(value: ClarityValue): string {
    return `0x${serializeCV(value)}`;
}

function extractTxIdFromResponse(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;

    const record = response as { txid?: unknown; txId?: unknown };
    if (typeof record.txid === 'string' && record.txid.trim().length > 0) {
        return record.txid;
    }
    if (typeof record.txId === 'string' && record.txId.trim().length > 0) {
        return record.txId;
    }
    return null;
}

function resolveFtAssetName(contractId: string): string {
    if (contractId === USDCX_CONTRACT_ID) return DEFAULT_USDCX_ASSET_NAME;
    return splitContractId(contractId).name;
}

export function buildSip10AssetIdentifier(assetContractId: string): AssetString {
    return `${assetContractId}::${resolveFtAssetName(assetContractId)}` as AssetString;
}

export function buildFtTransferPostConditionHex(
    sender: AddressString,
    amount: number,
    assetContractId: string
): string {
    const postCondition = Pc.principal(sender)
        .willSendEq(amount)
        .ft(assetContractId as ContractIdString, resolveFtAssetName(assetContractId));
    return postConditionToHex(postCondition);
}

function bufferCVFromHex32(value: string): ClarityValue {
    const raw = value.startsWith('0x') ? value.slice(2) : value;
    const normalized = raw.padEnd(64, '0').slice(0, 64);
    return bufferCV(hexToBytes(normalized));
}

function bufferCVFromText32(value: string): ClarityValue {
    const bytes = new TextEncoder().encode(value);
    const normalized = new Uint8Array(32);
    normalized.set(bytes.slice(0, 32));
    return bufferCV(normalized);
}

function extractAddress(stored: ReturnType<typeof getLocalStorage>): string | null {
    if (!stored?.addresses) return null;
    const addrs = stored.addresses as { stx?: Array<{ address: string }>; btc?: Array<{ address: string }> };
    if (addrs.stx && addrs.stx.length > 0) return addrs.stx[0].address;
    if (addrs.btc && addrs.btc.length > 0) return addrs.btc[0].address;
    return null;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseUintFromClarityHex(hex: string): number | null {
    try {
        const value = cvToValue(hexToCV(hex));
        if (typeof value === 'bigint') return Number(value);
        if (value && typeof value === 'object') {
            const record = value as { value?: string };
            const parsed = Number.parseInt(record.value || '', 10);
            if (Number.isFinite(parsed)) return parsed;
        }
    } catch {
        return null;
    }
    return null;
}

async function fetchTxById(txId: string): Promise<Record<string, unknown> | null> {
    const normalized = txId.trim();
    const candidates = normalized.startsWith('0x')
        ? [normalized, normalized.substring(2)]
        : [normalized, `0x${normalized}`];

    for (const candidate of candidates) {
        const res = await fetch(`${STACKS_API_BASE_URL}/extended/v1/tx/${candidate}`);
        if (!res.ok) continue;
        return (await res.json()) as Record<string, unknown>;
    }
    return null;
}

function classifyTxStatus(status: unknown): TxWaitOutcome {
    const normalized = String(status || '');
    if (normalized === 'success') return 'success';
    if (normalized === 'abort_by_response' || normalized === 'abort_by_post_condition') return 'failed';
    return 'pending';
}

async function fetchCurrentStacksHeight(): Promise<number | null> {
    try {
        const res = await fetch(`${STACKS_API_BASE_URL}/v2/info`);
        if (!res.ok) return null;
        const data = (await res.json()) as { stacks_tip_height?: unknown };
        const height = Number.parseInt(String(data.stacks_tip_height ?? ''), 10);
        if (!Number.isFinite(height) || height <= 0) return null;
        return height;
    } catch {
        return null;
    }
}

async function estimateDeadlineBlockHeight(deadlineUnixSeconds: number): Promise<number> {
    const nowUnix = Math.floor(Date.now() / 1000);
    const secondsUntilDeadline = Math.max(0, deadlineUnixSeconds - nowUnix);
    const estimatedBlocksUntilDeadline = Math.ceil(secondsUntilDeadline / 600); // ~10m/block
    const currentHeight = await fetchCurrentStacksHeight();
    if (currentHeight && currentHeight > 0) {
        return Math.max(1, currentHeight + Math.max(1, estimatedBlocksUntilDeadline));
    }
    return Math.max(1, estimatedBlocksUntilDeadline + 1);
}

function parseCreateCampaignIdFromTx(txData: Record<string, unknown>): number | null {
    const txResult = txData.tx_result;
    if (!txResult || typeof txResult !== 'object') return null;
    const hex = (txResult as { hex?: unknown }).hex;
    if (typeof hex !== 'string') return null;
    return parseUintFromClarityHex(hex);
}

// Read current campaign counter and derive next campaign id.
export async function getNextCampaignId(): Promise<number | null> {
    try {
        const owner = extractAddress(getLocalStorage());
        if (!owner) return null;

        const res = await fetch(
            `${STACKS_API_BASE_URL}/v2/contracts/call-read/${CONTRACT_ADDRESS}/${CONTRACT_NAME}/get-campaign-count`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sender: owner,
                    arguments: [],
                }),
            }
        );

        if (!res.ok) return null;
        const data = (await res.json()) as { okay?: boolean; result?: string };
        if (!data.okay || typeof data.result !== 'string') return null;

        const currentCounter = parseUintFromClarityHex(data.result);
        if (!currentCounter || currentCounter < 0) return 1;
        return currentCounter + 1;
    } catch (error) {
        console.error('[Contract] getNextCampaignId failed:', error);
        return null;
    }
}

// Poll tx endpoint until create-campaign returns a confirmed onchain id.
export async function waitForCreateCampaignId(
    txId: string,
    timeoutMs: number = 45000,
    pollIntervalMs: number = 3000
): Promise<number | null> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const txData = await fetchTxById(txId);
            if (txData) {
                const status = txData.tx_status;
                if (status === 'success') {
                    return parseCreateCampaignIdFromTx(txData);
                }
                if (status === 'abort_by_response' || status === 'abort_by_post_condition') {
                    return null;
                }
            }
        } catch (error) {
            console.error('[Contract] waitForCreateCampaignId poll failed:', error);
        }
        await sleep(pollIntervalMs);
    }
    return null;
}

// Poll transaction endpoint until a tx reaches success/failure or times out.
export async function waitForTxSuccess(
    txId: string,
    timeoutMs: number = 90000,
    pollIntervalMs: number = 3000
): Promise<TxWaitOutcome> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
        try {
            const txData = await fetchTxById(txId);
            if (txData) {
                const outcome = classifyTxStatus(txData.tx_status);
                if (outcome !== 'pending') return outcome;
            }
        } catch (error) {
            console.error('[Contract] waitForTxSuccess poll failed:', error);
        }
        await sleep(pollIntervalMs);
    }
    return 'pending';
}

// Connect wallet
export async function connectWallet(): Promise<string | null> {
    try {
        const response = await connect();
        if (response && typeof response === 'object' && 'addresses' in response) {
            const resp = response as { addresses: { stx?: Array<{ address: string }>; btc?: Array<{ address: string }> } };
            if (resp.addresses.stx && resp.addresses.stx.length > 0) {
                return resp.addresses.stx[0].address;
            }
        }
        // Try to get from local storage
        const stored = getLocalStorage();
        return extractAddress(stored);
    } catch (error) {
        console.error('[Wallet] Connection failed:', error);
        return null;
    }
}

// Disconnect wallet
export function disconnectWallet(): void {
    disconnect();
}

// Check if wallet is connected
export function checkWalletConnection(): WalletState {
    const connected = isConnected();
    let address: string | null = null;
    if (connected) {
        const stored = getLocalStorage();
        address = extractAddress(stored);
    }
    return { isConnected: connected, address };
}

// USDCx transfer (for x402 payment)
export async function transferUSDCx(
    amount: number,
    recipient: string,
    assetContractId: string = USDCX_CONTRACT_ID
): Promise<string | null> {
    try {
        const sender = extractAddress(getLocalStorage());
        if (!sender) throw new Error('Wallet address not found. Connect wallet first.');
        const encodedPostCondition = buildFtTransferPostConditionHex(sender as AddressString, amount, assetContractId);
        const assetIdentifier = buildSip10AssetIdentifier(assetContractId);

        try {
            const response = await request('stx_transferSip10Ft', {
                recipient,
                asset: assetIdentifier,
                amount: String(amount),
                network: NETWORK_ID,
            });
            const txId = extractTxIdFromResponse(response);
            if (txId) return txId;
        } catch (error) {
            console.warn('[Wallet] stx_transferSip10Ft failed, falling back to contract call:', error);
        }

        const fallbackResponse = await request('stx_callContract', {
            contract: assetContractId as ContractIdString,
            functionName: 'transfer',
            functionArgs: [
                serializeArg(uintCV(amount)),
                serializeArg(standardPrincipalCV(sender)),
                serializeArg(standardPrincipalCV(recipient)),
                serializeArg(noneCV()),
            ],
            network: NETWORK_ID,
            postConditions: [encodedPostCondition],
            postConditionMode: 'deny',
        });
        return extractTxIdFromResponse(fallbackResponse);
    } catch (error) {
        console.error('[Wallet] USDCx transfer failed:', error);
        return null;
    }
}

// Call contract: create-campaign
export async function callCreateCampaign(metadataHash: string): Promise<string | null> {
    try {
        const owner = extractAddress(getLocalStorage());
        if (!owner) throw new Error('Wallet address not found. Connect wallet first.');

        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'create-campaign',
            functionArgs: [
                serializeArg(standardPrincipalCV(owner)),
                serializeArg(someCV(contractPrincipalCV(USDCX_CONTRACT.address, USDCX_CONTRACT.name))),
                serializeArg(bufferCVFromHex32(metadataHash)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] create-campaign failed:', error);
        return null;
    }
}

// Call contract: fund-campaign
export async function callFundCampaign(campaignId: number, amount: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'fund-campaign',
            postConditionMode: 'allow',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(contractPrincipalCV(USDCX_CONTRACT.address, USDCX_CONTRACT.name)),
                serializeArg(uintCV(amount)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] fund-campaign failed:', error);
        return null;
    }
}

// Call contract: add-task
export async function callAddTask(
    campaignId: number,
    payout: number,
    deadlineUnixSeconds: number,
    criteria: string
): Promise<string | null> {
    try {
        const deadlineBlockHeight = await estimateDeadlineBlockHeight(deadlineUnixSeconds);
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'add-task',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(uintCV(payout)),
                serializeArg(uintCV(deadlineBlockHeight)),
                serializeArg(bufferCVFromText32(criteria)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] add-task failed:', error);
        return null;
    }
}

// Call contract: claim-task
export async function callClaimTask(campaignId: number, taskId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'claim-task',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(uintCV(taskId)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] claim-task failed:', error);
        return null;
    }
}

// Call contract: submit-proof
export async function callSubmitProof(campaignId: number, taskId: number, proof: string): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'submit-proof',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(uintCV(taskId)),
                serializeArg(bufferCVFromText32(proof)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] submit-proof failed:', error);
        return null;
    }
}

// Call contract: approve-task (triggers payout)
export async function callApproveTask(campaignId: number, taskId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'approve-task',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(uintCV(taskId)),
                serializeArg(contractPrincipalCV(USDCX_CONTRACT.address, USDCX_CONTRACT.name)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] approve-task failed:', error);
        return null;
    }
}

// Call contract: cancel-task
export async function callCancelTask(campaignId: number, taskId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'cancel-task',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(uintCV(taskId)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] cancel-task failed:', error);
        return null;
    }
}

// Call contract: close-campaign
export async function callCloseCampaign(campaignId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'close-campaign',
            functionArgs: [serializeArg(uintCV(campaignId))],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] close-campaign failed:', error);
        return null;
    }
}

// Call contract: withdraw-remaining
export async function callWithdrawRemaining(campaignId: number, amount: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: CONTRACT_ID,
            functionName: 'withdraw-remaining',
            functionArgs: [
                serializeArg(uintCV(campaignId)),
                serializeArg(contractPrincipalCV(USDCX_CONTRACT.address, USDCX_CONTRACT.name)),
                serializeArg(uintCV(amount)),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return null;
    } catch (error) {
        console.error('[Contract] withdraw-remaining failed:', error);
        return null;
    }
}
