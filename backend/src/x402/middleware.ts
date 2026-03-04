import { Request, Response, NextFunction } from 'express';
import { buildAlphaCacheKey, isAlphaQueryCached } from '../storage/store';

/**
 * x402 Payment Middleware for ThesisRail
 * 
 * Implements the HTTP 402 Payment Required flow:
 * 1. Client requests a paid resource
 * 2. Server responds with 402 + payment requirements
 * 3. Client pays (STX transfer) and retries with X-Payment header
 * 4. Server validates proof and serves the resource
 * 
 * Verification: checks transfer tx on Stacks API (status, recipient, amount).
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
}

interface PaymentProof {
    txId?: string;
    signature?: string;
    demo?: boolean;
}

interface TokenTransferPayload {
    recipient_address?: string;
    amount?: string | number;
}

interface StacksTxPayload {
    tx_status?: string;
    tx_type?: string;
    token_transfer?: TokenTransferPayload;
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
    const premiumPrice = process.env.ALPHA_CARDS_PRICE_STX || '1000000';
    const cachedPrice = process.env.ALPHA_CARDS_PRICE_CACHED_STX || '250000';

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

function buildPaymentRequirements(req: Request): PaymentRequirements {
    return {
        version: '1',
        network: 'stacks-testnet',
        token: 'STX',
        amount: getDynamicPrice(req),
        receiver: process.env.PAYMENT_RECEIVER_ADDRESS || 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
        description: 'ThesisRail Alpha Cards — pay-per-signal access',
        resource: req.originalUrl,
        scheme: 'stx-transfer',
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
            step1: 'Transfer the specified amount of STX to the receiver address',
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
    for (const baseUrl of candidates) {
        try {
            const response = await fetch(`${baseUrl}/extended/v1/tx/${txId}`);
            if (!response.ok) continue;
            const payload = (await response.json()) as StacksTxPayload;
            return payload;
        } catch {
            continue;
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
    if (txData.tx_type !== 'token_transfer') return false;

    const expectedAmount = parseAmount(requirements.amount);
    const paidAmount = parseAmount(txData.token_transfer?.amount);
    const recipient = txData.token_transfer?.recipient_address;

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
            message: 'Payment proof verification failed. Submit a confirmed STX transfer txId that matches receiver and amount.',
            reason: 'invalid_payment_proof',
        });
        return;
    }

    // Payment verified — proceed to the actual handler
    next();
}
