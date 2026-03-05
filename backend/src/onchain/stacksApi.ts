export interface TxFunctionArg {
    repr?: string;
}

export interface TxContractCall {
    contract_id?: string;
    function_name?: string;
    function_args?: TxFunctionArg[];
}

export interface StacksTxPayload {
    tx_id?: string;
    tx_status?: string;
    tx_type?: string;
    sender_address?: string;
    contract_call?: TxContractCall;
}

const FAILED_TX_STATUSES = new Set([
    'abort_by_response',
    'abort_by_post_condition',
    'dropped_replace_by_fee',
    'dropped_stale_garbage_collect',
    'dropped_too_expensive',
    'dropped_problematic',
]);

export function normalizeStacksAddress(value: string): string {
    return value.trim().toUpperCase();
}

export function parseUintReprToNumber(repr: unknown): number | null {
    if (typeof repr !== 'string' || !/^u\d+$/.test(repr)) return null;
    try {
        const asBigInt = BigInt(repr.substring(1));
        if (asBigInt <= BigInt(0)) return null;
        if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
        return Number(asBigInt);
    } catch {
        return null;
    }
}

export function parsePrincipalRepr(repr: unknown): string | null {
    if (typeof repr !== 'string') return null;
    const trimmed = repr.trim();
    if (!trimmed.startsWith("'") || trimmed.length < 3) return null;
    return trimmed.substring(1);
}

function getStacksApiBaseCandidates(): string[] {
    const fromEnv = process.env.STACKS_API_BASE_URL?.trim();
    if (fromEnv) return [fromEnv.replace(/\/$/, '')];
    const network = (process.env.STACKS_NETWORK || 'testnet').toLowerCase();
    if (network === 'mainnet') {
        return ['https://api.hiro.so', 'https://stacks-node-api.mainnet.stacks.co'];
    }
    return ['https://api.testnet.hiro.so', 'https://stacks-node-api.testnet.stacks.co'];
}

export async function fetchStacksTxById(txId: string): Promise<StacksTxPayload | null> {
    const normalized = txId.trim();
    if (!normalized) return null;

    const candidates = normalized.startsWith('0x')
        ? [normalized, normalized.substring(2)]
        : [normalized, `0x${normalized}`];

    for (const baseUrl of getStacksApiBaseCandidates()) {
        for (const candidate of candidates) {
            try {
                const response = await fetch(`${baseUrl}/extended/v1/tx/${candidate}`);
                if (!response.ok) continue;
                return (await response.json()) as StacksTxPayload;
            } catch {
                continue;
            }
        }
    }
    return null;
}

export function classifyTxLifecycleStatus(
    tx: StacksTxPayload | null
): 'not_found' | 'pending' | 'confirmed' | 'failed' {
    if (!tx) return 'not_found';
    const status = (tx.tx_status || '').toLowerCase();
    if (status === 'success') return 'confirmed';
    if (status.startsWith('pending')) return 'pending';
    if (FAILED_TX_STATUSES.has(status)) return 'failed';
    if (status.startsWith('abort') || status.startsWith('dropped')) return 'failed';
    return 'pending';
}
