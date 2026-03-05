import { Request, Response, NextFunction } from 'express';
import { buildAlphaCacheKey, isAlphaQueryCached } from '../storage/store';

/**
 * x402 Payment Middleware for ThesisRail
 * 
 * Implements the HTTP 402 Payment Required flow:
 * 1. Client requests a paid resource
 * 2. Server responds with 402 + payment requirements
 * 3. Client pays (USDCx transfer) and retries with X-Payment header
 * 4. Server validates proof and serves the resource
 * 
 * Verification: checks USDCx transfer contract-call tx on Stacks API.
 */

export interface PaymentRequirements {
    version: string;
    network: string;
    token: string;
    amount: string;
    receiver: string;
    description: string;
    resource: string;
    scheme: string;
    asset_contract?: string;
}

interface PaymentProof {
    txId?: string;
    signature?: string;
    demo?: boolean;
}

interface TxFunctionArgPayload {
    repr?: string;
}

interface ContractCallPayload {
    contract_id?: string;
    function_name?: string;
    function_args?: TxFunctionArgPayload[];
}

interface StacksTxPayload {
    tx_status?: string;
    tx_type?: string;
    contract_call?: ContractCallPayload;
}

const X_PAYMENT_REQUIRED_HEADER = 'x-payment-required';
const X_PAYMENT_PROTOCOL_HEADER = 'x-payment-protocol';

function readQueryString(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string') return value[0];
    return fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(readQueryString(value, ''), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getDynamicPrice(req: Request): string {
    const premiumPrice = process.env.ALPHA_CARDS_PRICE_USDCX || process.env.ALPHA_CARDS_PRICE_STX || '1000000';
    const cachedPrice = process.env.ALPHA_CARDS_PRICE_CACHED_USDCX || process.env.ALPHA_CARDS_PRICE_CACHED_STX || '250000';

    if (req.path.includes('/clusters') || req.path.includes('/creators')) {
        return premiumPrice;
    }

    if (!req.path.includes('/cards')) {
        return premiumPrice;
    }

    const source = readQueryString(req.query.source, 'both');
    const window = readQueryString(req.query.window, '24h');
    const n = Math.min(readPositiveInt(req.query.n, 20), 50);
    const cacheKey = buildAlphaCacheKey(source, window, n);
    const cacheTtlMs = Number.parseInt(process.env.ALPHA_CACHE_TTL_MS || '300000', 10);

    return isAlphaQueryCached(cacheKey, cacheTtlMs) ? cachedPrice : premiumPrice;
}

function resolveStacksNetworkName(): 'stacks-mainnet' | 'stacks-testnet' {
    return (process.env.STACKS_NETWORK || 'testnet').toLowerCase() === 'mainnet'
        ? 'stacks-mainnet'
        : 'stacks-testnet';
}

function resolveUsdcxContractId(network: string): string {
    const configured = process.env.USDCX_CONTRACT_ID?.trim();
    if (configured) return configured;
    if (network === 'stacks-mainnet') {
        return 'SP3Y2H4J1FMEDV4R5DVG4RG3VD53QH931Y2PY6JQ5.usdcx-token';
    }
    return 'ST14W0V5M1A0NNRPVQ54E9G0Z4K72902R8Q2A5AS5.usdcx-token';
}

function buildPaymentRequirements(req: Request): PaymentRequirements {
    const network = resolveStacksNetworkName();
    return {
        version: '1',
        network,
        token: 'USDCX',
        amount: getDynamicPrice(req),
        receiver: process.env.PAYMENT_RECEIVER_ADDRESS || 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
        description: 'ThesisRail Alpha Cards — pay-per-signal access (USDCx)',
        resource: req.originalUrl,
        scheme: 'sip10-transfer',
        asset_contract: resolveUsdcxContractId(network),
    };
}

function encodePaymentRequirementsHeader(requirements: PaymentRequirements): string {
    return Buffer.from(JSON.stringify(requirements), 'utf8').toString('base64');
}

function respondPaymentRequired(
    res: Response,
    requirements: PaymentRequirements,
    payload: {
        error: string;
        message: string;
        reason: 'missing_payment_proof' | 'invalid_payment_proof';
    }
): void {
    res.setHeader(X_PAYMENT_PROTOCOL_HEADER, 'x402');
    res.setHeader(X_PAYMENT_REQUIRED_HEADER, encodePaymentRequirementsHeader(requirements));
    res.setHeader('Cache-Control', 'no-store');

    res.status(402).json({
        status: 402,
        error: payload.error,
        message: payload.message,
        reason: payload.reason,
        paymentRequirements: requirements,
        instructions: {
            step1: 'Call USDCx transfer with the specified amount and receiver address',
            step2: 'Include the transaction proof in the X-Payment header',
            step3: 'Retry this request with the X-Payment header',
        },
    });
}

function parsePaymentProof(paymentHeader: string): PaymentProof | null {
    try {
        const proof = JSON.parse(paymentHeader) as PaymentProof;
        if (proof && typeof proof === 'object') return proof;
        return null;
    } catch {
        if (paymentHeader.length > 0) return { txId: paymentHeader };
        return null;
    }
}

function parseAmount(value: string | number | undefined): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        const parsed = Number.parseInt(value, 10);
        if (Number.isFinite(parsed)) return parsed;
    }
    return null;
}

function parsePrincipalRepr(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed.startsWith("'") || trimmed.length < 3) return null;
    return trimmed.substring(1);
}

function getApiBaseCandidates(network: string): string[] {
    const fromEnv = process.env.STACKS_API_BASE_URL?.trim();
    if (fromEnv) return [fromEnv.replace(/\/$/, '')];
    if (network === 'stacks-mainnet') {
        return ['https://api.hiro.so', 'https://stacks-node-api.mainnet.stacks.co'];
    }
    return ['https://api.testnet.hiro.so', 'https://stacks-node-api.testnet.stacks.co'];
}

async function fetchTxById(network: string, txId: string): Promise<StacksTxPayload | null> {
    const candidates = getApiBaseCandidates(network);
    const txCandidates = txId.startsWith('0x') ? [txId, txId.substring(2)] : [txId, `0x${txId}`];
    for (const baseUrl of candidates) {
        for (const txCandidate of txCandidates) {
            try {
                const response = await fetch(`${baseUrl}/extended/v1/tx/${txCandidate}`);
                if (!response.ok) continue;
                const payload = (await response.json()) as StacksTxPayload;
                return payload;
            } catch {
                continue;
            }
        }
    }
    return null;
}

async function validatePaymentProof(paymentHeader: string, requirements: PaymentRequirements): Promise<boolean> {
    const proof = parsePaymentProof(paymentHeader);
    if (!proof) return false;

    const allowDemo = process.env.X402_ALLOW_DEMO_PROOF === 'true';
    if (allowDemo && proof.demo) return true;

    if (!proof.txId) return false;
    const txData = await fetchTxById(requirements.network, proof.txId);
    if (!txData) return false;

    const acceptedStatuses = new Set(['success']);
    if (!acceptedStatuses.has(String(txData.tx_status || ''))) return false;
    if (txData.tx_type !== 'contract_call') return false;

    const contractCall = txData.contract_call;
    if (!contractCall || contractCall.function_name !== 'transfer') return false;

    const expectedAssetContract = requirements.asset_contract || resolveUsdcxContractId(requirements.network);
    if (!contractCall.contract_id || contractCall.contract_id !== expectedAssetContract) return false;

    const args = Array.isArray(contractCall.function_args) ? contractCall.function_args : [];

    const expectedAmount = parseAmount(requirements.amount);
    const paidAmount = parseAmount(args[0]?.repr?.replace(/^u/, ''));
    const recipient = parsePrincipalRepr(args[2]?.repr);

    if (expectedAmount === null || paidAmount === null) return false;
    if (!recipient || recipient !== requirements.receiver) return false;
    if (paidAmount < expectedAmount) return false;

    return true;
}

export async function x402Middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const paymentHeader = req.headers['x-payment'] as string | undefined;
    const requirements = buildPaymentRequirements(req);

    if (!paymentHeader) {
        respondPaymentRequired(res, requirements, {
            error: 'Payment Required',
            message: 'This endpoint requires payment via x402 protocol. Include an X-Payment header with proof of payment.',
            reason: 'missing_payment_proof',
        });
        return;
    }

    // Validate the payment proof
    if (!(await validatePaymentProof(paymentHeader, requirements))) {
        respondPaymentRequired(res, requirements, {
            error: 'Invalid Payment Proof',
            message: 'Payment proof verification failed. Submit a confirmed USDCx transfer txId that matches receiver and amount.',
            reason: 'invalid_payment_proof',
        });
        return;
    }

    // Payment verified — proceed to the actual handler
    next();
}
