import { Request, Response, NextFunction } from 'express';
import {
    buildAlphaCacheKey,
    isAlphaQueryCached,
    getConsumedPaymentProof,
    markConsumedPaymentProof,
} from '../storage/store';

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
    tx_id?: string;
    sender_address?: string;
    tx_status?: string;
    tx_type?: string;
    contract_call?: ContractCallPayload;
}

const X_PAYMENT_REQUIRED_HEADER = 'x-payment-required';
const X_PAYMENT_PROTOCOL_HEADER = 'x-payment-protocol';
const STACKS_ADDRESS_REGEX = /^S[A-Z0-9]{20,80}$/;

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
        return 'SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx';
    }
    return 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM.usdcx';
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
        if (!proof || typeof proof !== 'object') return null;
        const normalized: PaymentProof = {};
        if (typeof proof.txId === 'string') normalized.txId = proof.txId;
        if (typeof proof.signature === 'string') normalized.signature = proof.signature;
        if (proof.demo === true) normalized.demo = true;
        if (normalized.txId || normalized.signature || normalized.demo) return normalized;
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

function normalizeAddress(value: string): string {
    return value.trim().toUpperCase();
}

function normalizeTxId(value: string): string {
    const compact = value.trim().toLowerCase();
    if (compact.startsWith('0x')) return compact.substring(2);
    return compact;
}

function isStacksAddress(value: string): boolean {
    return STACKS_ADDRESS_REGEX.test(value);
}

function readCallerAddress(req: Request): string | null {
    const primary = req.header('x-caller-address');
    if (typeof primary === 'string' && primary.trim().length > 0) return normalizeAddress(primary);
    const fallback = req.header('x-wallet-address');
    if (typeof fallback === 'string' && fallback.trim().length > 0) return normalizeAddress(fallback);
    return null;
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

async function validatePaymentProof(
    paymentHeader: string,
    requirements: PaymentRequirements,
    caller: string
): Promise<{ ok: true; txId: string; payer: string } | { ok: false; reason: string }> {
    const proof = parsePaymentProof(paymentHeader);
    if (!proof) return { ok: false, reason: 'Missing payment proof payload' };

    const allowDemo = process.env.X402_ALLOW_DEMO_PROOF === 'true';
    if (allowDemo && proof.demo) {
        return { ok: true, txId: `demo-${Date.now()}`, payer: caller };
    }

    if (!proof.txId) return { ok: false, reason: 'Missing txId in payment proof' };
    const txId = normalizeTxId(proof.txId);
    if (!txId) return { ok: false, reason: 'Invalid txId in payment proof' };

    const consumed = getConsumedPaymentProof(txId);
    if (consumed) {
        return { ok: false, reason: 'Payment proof already consumed' };
    }

    const txData = await fetchTxById(requirements.network, proof.txId);
    if (!txData) return { ok: false, reason: 'Unable to fetch tx from Stacks API' };

    const acceptedStatuses = new Set(['success']);
    if (!acceptedStatuses.has(String(txData.tx_status || ''))) {
        return { ok: false, reason: 'Payment tx not confirmed as success' };
    }
    if (txData.tx_type !== 'contract_call') {
        return { ok: false, reason: 'Payment tx must be a contract-call transfer' };
    }

    const contractCall = txData.contract_call;
    if (!contractCall || contractCall.function_name !== 'transfer') {
        return { ok: false, reason: 'Payment tx is not a token transfer call' };
    }

    const expectedAssetContract = requirements.asset_contract || resolveUsdcxContractId(requirements.network);
    if (!contractCall.contract_id || contractCall.contract_id !== expectedAssetContract) {
        return { ok: false, reason: 'Payment tx token contract mismatch' };
    }

    const args = Array.isArray(contractCall.function_args) ? contractCall.function_args : [];

    const expectedAmount = parseAmount(requirements.amount);
    const paidAmount = parseAmount(args[0]?.repr?.replace(/^u/, ''));
    const transferSender = parsePrincipalRepr(args[1]?.repr);
    const recipient = parsePrincipalRepr(args[2]?.repr);
    const txSender = normalizeAddress(txData.sender_address || '');
    const normalizedCaller = normalizeAddress(caller);

    if (expectedAmount === null || paidAmount === null) {
        return { ok: false, reason: 'Payment amount parsing failed' };
    }
    if (!recipient || recipient !== requirements.receiver) {
        return { ok: false, reason: 'Payment receiver mismatch' };
    }
    if (paidAmount < expectedAmount) {
        return { ok: false, reason: 'Payment amount is below required amount' };
    }
    if (!transferSender || normalizeAddress(transferSender) !== txSender) {
        return { ok: false, reason: 'Payment tx sender does not match transfer sender argument' };
    }
    if (txSender !== normalizedCaller) {
        return { ok: false, reason: 'Payment tx sender does not match X-Caller-Address' };
    }

    return { ok: true, txId, payer: txSender };
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

    const caller = readCallerAddress(req);
    if (!caller || !isStacksAddress(caller)) {
        res.status(401).json({
            status: 401,
            error: 'Missing or invalid caller address',
            message: 'Include a valid STX address in X-Caller-Address when submitting X-Payment proof.',
        });
        return;
    }

    // Validate the payment proof
    const verification = await validatePaymentProof(paymentHeader, requirements, caller);
    if (!verification.ok) {
        respondPaymentRequired(res, requirements, {
            error: 'Invalid Payment Proof',
            message: `Payment proof verification failed: ${verification.reason}. Submit a confirmed USDCx transfer txId that matches caller, receiver, and amount.`,
            reason: 'invalid_payment_proof',
        });
        return;
    }

    markConsumedPaymentProof({
        tx_id: verification.txId,
        payer: verification.payer,
        receiver: requirements.receiver,
        amount: requirements.amount,
        resource: req.originalUrl,
    });

    // Payment verified — proceed to the actual handler
    next();
}
