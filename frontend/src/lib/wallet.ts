/**
 * Stacks Wallet Integration
 * Wraps @stacks/connect for wallet connection and contract interactions.
 */

import { request, connect, isConnected, disconnect, getLocalStorage } from '@stacks/connect';
import { hexToCV, cvToValue } from '@stacks/transactions';

const CONTRACT_ADDRESS = process.env.NEXT_PUBLIC_CONTRACT_ADDRESS || 'ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM';
const CONTRACT_NAME = process.env.NEXT_PUBLIC_CONTRACT_NAME || 'thesis-rail-escrow-v4';
const NETWORK_ID = process.env.NEXT_PUBLIC_NETWORK || 'testnet';
const STACKS_API_BASE_URL = (
    process.env.NEXT_PUBLIC_STACKS_API_URL ||
    (NETWORK_ID === 'mainnet' ? 'https://api.hiro.so' : 'https://api.testnet.hiro.so')
).replace(/\/$/, '');

export interface WalletState {
    isConnected: boolean;
    address: string | null;
}

function textToClarityBuffer32(value: string): string {
    const bytes = new TextEncoder().encode(value);
    const normalized = Array.from(bytes.slice(0, 32));
    while (normalized.length < 32) normalized.push(0);
    const hex = normalized.map((byte) => byte.toString(16).padStart(2, '0')).join('');
    return `0x${hex}`;
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
    const res = await fetch(`${STACKS_API_BASE_URL}/extended/v1/tx/${txId}`);
    if (!res.ok) return null;
    return (await res.json()) as Record<string, unknown>;
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

// STX Transfer (for x402 payment)
export async function transferSTX(amount: number, recipient: string): Promise<string | null> {
    try {
        const response = await request('stx_transferStx', {
            amount: String(amount),
            recipient,
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return 'demo-tx-' + Date.now();
    } catch (error) {
        console.error('[Wallet] STX transfer failed:', error);
        return null;
    }
}

// Call contract: create-campaign
export async function callCreateCampaign(metadataHash: string): Promise<string | null> {
    try {
        const owner = extractAddress(getLocalStorage());
        if (!owner) throw new Error('Wallet address not found. Connect wallet first.');

        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'create-campaign',
            functionArgs: [
                `'${owner}`,
                'none',
                `0x${metadataHash.replace('0x', '').padEnd(64, '0').substring(0, 64)}`,
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return 'demo-create-' + Date.now();
    } catch (error) {
        console.error('[Contract] create-campaign failed:', error);
        return null;
    }
}

// Call contract: fund-campaign
export async function callFundCampaign(campaignId: number, amount: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'fund-campaign',
            functionArgs: [
                `u${campaignId}`,
                `u${amount}`,
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return 'demo-fund-' + Date.now();
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
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'add-task',
            functionArgs: [
                `u${campaignId}`,
                `u${payout}`,
                `u${Math.max(1, deadlineUnixSeconds)}`,
                textToClarityBuffer32(criteria),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return `demo-add-task-${Date.now()}`;
    } catch (error) {
        console.error('[Contract] add-task failed:', error);
        return null;
    }
}

// Call contract: claim-task
export async function callClaimTask(campaignId: number, taskId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'claim-task',
            functionArgs: [
                `u${campaignId}`,
                `u${taskId}`,
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return `demo-claim-${Date.now()}`;
    } catch (error) {
        console.error('[Contract] claim-task failed:', error);
        return null;
    }
}

// Call contract: submit-proof
export async function callSubmitProof(campaignId: number, taskId: number, proof: string): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'submit-proof',
            functionArgs: [
                `u${campaignId}`,
                `u${taskId}`,
                textToClarityBuffer32(proof),
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return `demo-submit-${Date.now()}`;
    } catch (error) {
        console.error('[Contract] submit-proof failed:', error);
        return null;
    }
}

// Call contract: approve-task (triggers payout)
export async function callApproveTask(campaignId: number, taskId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'approve-task',
            functionArgs: [
                `u${campaignId}`,
                `u${taskId}`,
            ],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return 'demo-approve-' + Date.now();
    } catch (error) {
        console.error('[Contract] approve-task failed:', error);
        return null;
    }
}

// Call contract: close-campaign
export async function callCloseCampaign(campaignId: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'close-campaign',
            functionArgs: [`u${campaignId}`],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return `demo-close-${Date.now()}`;
    } catch (error) {
        console.error('[Contract] close-campaign failed:', error);
        return null;
    }
}

// Call contract: withdraw-remaining
export async function callWithdrawRemaining(campaignId: number, amount: number): Promise<string | null> {
    try {
        const response = await request('stx_callContract', {
            contract: `${CONTRACT_ADDRESS}.${CONTRACT_NAME}`,
            functionName: 'withdraw-remaining',
            functionArgs: [`u${campaignId}`, `u${amount}`],
            network: NETWORK_ID,
        });
        if (response && typeof response === 'object' && 'txid' in response) {
            return (response as { txid: string }).txid;
        }
        return `demo-withdraw-${Date.now()}`;
    } catch (error) {
        console.error('[Contract] withdraw-remaining failed:', error);
        return null;
    }
}
