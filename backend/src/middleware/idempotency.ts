import type { Request, Response } from 'express';

const IDEMPOTENCY_HEADER = 'x-idempotency-key';
const IDEMPOTENCY_KEY_REGEX = /^[A-Za-z0-9._:-]+$/;
const IDEMPOTENCY_KEY_MAX_LENGTH = 128;
const STORE_TTL_MS = Number.parseInt(process.env.IDEMPOTENCY_TTL_MS || '86400000', 10);
const STORE_MAX_ENTRIES = Number.parseInt(process.env.IDEMPOTENCY_MAX_ENTRIES || '2000', 10);

interface StoredIdempotentResponse {
    fingerprint: string;
    statusCode: number;
    body: unknown;
    createdAt: number;
}

export interface IdempotencyContext {
    scope: string;
    fingerprint: string;
}

type StartResult =
    | { kind: 'missing_key'; message: string }
    | { kind: 'invalid_key'; message: string }
    | { kind: 'conflict'; message: string }
    | { kind: 'replay'; statusCode: number; body: unknown }
    | { kind: 'new'; scope: string; fingerprint: string };

const responseStore = new Map<string, StoredIdempotentResponse>();

function isFinitePositiveNumber(value: number): boolean {
    return Number.isFinite(value) && value > 0;
}

function resolveStoreTtlMs(): number {
    return isFinitePositiveNumber(STORE_TTL_MS) ? STORE_TTL_MS : 86400000;
}

function resolveStoreMaxEntries(): number {
    return isFinitePositiveNumber(STORE_MAX_ENTRIES) ? STORE_MAX_ENTRIES : 2000;
}

function canonicalizeValue(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => canonicalizeValue(entry));
    }
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
            a.localeCompare(b)
        );
        const normalized: Record<string, unknown> = {};
        for (const [key, inner] of entries) {
            if (typeof inner === 'undefined') continue;
            normalized[key] = canonicalizeValue(inner);
        }
        return normalized;
    }
    if (typeof value === 'string') {
        return value.trim();
    }
    return value;
}

function buildRequestFingerprint(req: Request): string {
    return JSON.stringify({
        method: req.method.toUpperCase(),
        path: `${req.baseUrl}${req.path}`,
        query: canonicalizeValue(req.query),
        body: canonicalizeValue(req.body),
    });
}

function readIdempotencyKey(req: Request): string | null {
    const raw = req.header(IDEMPOTENCY_HEADER);
    if (typeof raw !== 'string') return null;
    const key = raw.trim();
    return key.length > 0 ? key : null;
}

function validateIdempotencyKey(key: string): string | null {
    if (key.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
        return `X-Idempotency-Key must be <= ${IDEMPOTENCY_KEY_MAX_LENGTH} characters`;
    }
    if (!IDEMPOTENCY_KEY_REGEX.test(key)) {
        return 'X-Idempotency-Key contains unsupported characters';
    }
    return null;
}

function normalizeCaller(caller: string): string {
    return caller.trim().toUpperCase();
}

function buildScope(req: Request, caller: string, idempotencyKey: string): string {
    return `${req.method.toUpperCase()}:${req.baseUrl}${req.path}:${normalizeCaller(caller)}:${idempotencyKey}`;
}

function isExpired(record: StoredIdempotentResponse): boolean {
    return Date.now() - record.createdAt > resolveStoreTtlMs();
}

function pruneStore(): void {
    if (responseStore.size === 0) return;

    for (const [scope, record] of responseStore.entries()) {
        if (isExpired(record)) {
            responseStore.delete(scope);
        }
    }

    const maxEntries = resolveStoreMaxEntries();
    if (responseStore.size <= maxEntries) return;

    const ordered = Array.from(responseStore.entries()).sort((a, b) => a[1].createdAt - b[1].createdAt);
    const removeCount = responseStore.size - maxEntries;
    for (let i = 0; i < removeCount; i += 1) {
        responseStore.delete(ordered[i][0]);
    }
}

function startIdempotency(req: Request, caller: string): StartResult {
    pruneStore();

    const idempotencyKey = readIdempotencyKey(req);
    if (!idempotencyKey) {
        return {
            kind: 'missing_key',
            message: 'X-Idempotency-Key header is required for mutation endpoints',
        };
    }

    const keyValidationError = validateIdempotencyKey(idempotencyKey);
    if (keyValidationError) {
        return { kind: 'invalid_key', message: keyValidationError };
    }

    const scope = buildScope(req, caller, idempotencyKey);
    const fingerprint = buildRequestFingerprint(req);

    const existing = responseStore.get(scope);
    if (!existing) {
        return { kind: 'new', scope, fingerprint };
    }

    if (isExpired(existing)) {
        responseStore.delete(scope);
        return { kind: 'new', scope, fingerprint };
    }

    if (existing.fingerprint !== fingerprint) {
        return {
            kind: 'conflict',
            message: 'X-Idempotency-Key was already used with a different request payload',
        };
    }

    return {
        kind: 'replay',
        statusCode: existing.statusCode,
        body: existing.body,
    };
}

export function beginMutationIdempotency(
    req: Request,
    res: Response,
    caller: string
): IdempotencyContext | null {
    const result = startIdempotency(req, caller);
    switch (result.kind) {
        case 'missing_key':
        case 'invalid_key':
            res.status(400).json({ error: result.message });
            return null;
        case 'conflict':
            res.status(409).json({ error: result.message });
            return null;
        case 'replay':
            res.setHeader('X-Idempotency-Replay', 'true');
            res.status(result.statusCode).json(result.body);
            return null;
        case 'new':
            return { scope: result.scope, fingerprint: result.fingerprint };
        default:
            return null;
    }
}

export function sendIdempotentResponse(
    res: Response,
    context: IdempotencyContext,
    statusCode: number,
    body: unknown
): void {
    responseStore.set(context.scope, {
        fingerprint: context.fingerprint,
        statusCode,
        body,
        createdAt: Date.now(),
    });
    res.status(statusCode).json(body);
}
