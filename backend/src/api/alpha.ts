/**
 * Alpha API Routes
 * GET /v1/alpha/cards — x402 enforced, returns scored alpha signals
 */

import { Router, Request, Response } from 'express';
import { x402Middleware } from '../x402/middleware';
import { fetchRedditAlpha } from '../ingestion/reddit';
import { fetchYouTubeAlpha } from '../ingestion/youtube';
import { scoreRedditPost, scoreYouTubeVideo, AlphaCard } from '../scoring/alphaScorer';
import {
    storeAlphaCards,
    getAlphaCard,
    getAllAlphaCards,
    buildAlphaCacheKey,
    getAlphaCardsForQuery,
    isAlphaQueryCached,
    storeAlphaCardsForQuery,
} from '../storage/store';

export const alphaRouter = Router();
const VALID_SOURCES = new Set(['reddit', 'youtube', 'both']);
const VALID_WINDOWS = new Set(['24h', '7d']);

function readQueryString(value: unknown, fallback: string): string {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value)) {
        const first = value.find((entry): entry is string => typeof entry === 'string' && entry.length > 0);
        if (first) return first;
    }
    return fallback;
}

function readPositiveInt(value: unknown, fallback: number): number {
    const raw = readQueryString(value, '');
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeSource(value: unknown): 'reddit' | 'youtube' | 'both' {
    const candidate = readQueryString(value, 'both');
    return VALID_SOURCES.has(candidate) ? (candidate as 'reddit' | 'youtube' | 'both') : 'both';
}

function normalizeWindow(value: unknown): '24h' | '7d' {
    const candidate = readQueryString(value, '24h');
    return VALID_WINDOWS.has(candidate) ? (candidate as '24h' | '7d') : '24h';
}

function readParam(value: string | string[] | undefined): string | null {
    if (typeof value === 'string' && value.length > 0) return value;
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === 'string' && value[0].length > 0) {
        return value[0];
    }
    return null;
}

// GET /v1/alpha/cards — x402 enforced
alphaRouter.get('/cards', x402Middleware, async (req: Request, res: Response) => {
    try {
        const source = normalizeSource(req.query.source);
        const window = normalizeWindow(req.query.window);
        const n = Math.min(readPositiveInt(req.query.n, 20), 50);
        const cacheKey = buildAlphaCacheKey(source, window, n);
        const cacheTtlMs = Number.parseInt(process.env.ALPHA_CACHE_TTL_MS || '300000', 10);

        if (isAlphaQueryCached(cacheKey, cacheTtlMs)) {
            const cached = getAlphaCardsForQuery(cacheKey);
            if (cached) {
                res.json({
                    status: 200,
                    count: cached.cards.length,
                    source,
                    window,
                    cards: cached.cards,
                    meta: {
                        protocol: 'x402',
                        payment_verified: true,
                        cache_hit: true,
                        cached_at: new Date(cached.cached_at).toISOString(),
                        timestamp: new Date().toISOString(),
                    },
                });
                return;
            }
        }

        let cards: AlphaCard[] = [];

        if (source === 'reddit' || source === 'both') {
            const posts = await fetchRedditAlpha(window, Math.ceil(n / (source === 'both' ? 2 : 1)));
            const redditCards = posts.map((p) => scoreRedditPost(p, window));
            cards = cards.concat(redditCards);
        }

        if (source === 'youtube' || source === 'both') {
            const videos = await fetchYouTubeAlpha(window, Math.ceil(n / (source === 'both' ? 2 : 1)));
            const ytCards = videos.map((v) => scoreYouTubeVideo(v, window));
            cards = cards.concat(ytCards);
        }

        // Sort by alpha_score descending
        cards.sort((a, b) => b.alpha_score - a.alpha_score);
        cards = cards.slice(0, n);

        // Store for later retrieval
        storeAlphaCards(cards);
        storeAlphaCardsForQuery(cacheKey, cards);

        res.json({
            status: 200,
            count: cards.length,
            source,
            window,
            cards,
            meta: {
                protocol: 'x402',
                payment_verified: true,
                cache_hit: false,
                timestamp: new Date().toISOString(),
            },
        });
    } catch (error) {
        console.error('[Alpha API] Error:', error);
        res.status(500).json({ error: 'Failed to fetch alpha signals' });
    }
});

// GET /v1/alpha/clusters?window=24h|7d — optional paid clustering endpoint
alphaRouter.get('/clusters', x402Middleware, (req: Request, res: Response) => {
    const window = normalizeWindow(req.query.window);
    const cards = getAllAlphaCards().filter((card) => card.time_window === window);
    const grouped = new Map<string, AlphaCard[]>();

    cards.forEach((card) => {
        const key = card.source;
        const existing = grouped.get(key) || [];
        existing.push(card);
        grouped.set(key, existing);
    });

    const clusters = Array.from(grouped.entries()).map(([cluster, entries]) => {
        const avgScore = Math.round(entries.reduce((sum, card) => sum + card.alpha_score, 0) / entries.length);
        return {
            cluster,
            count: entries.length,
            avg_alpha_score: avgScore,
            top_thesis: entries
                .slice()
                .sort((a, b) => b.alpha_score - a.alpha_score)
                .slice(0, 3)
                .map((card) => card.thesis),
        };
    });

    res.json({
        status: 200,
        window,
        clusters,
        meta: {
            protocol: 'x402',
            payment_verified: true,
            timestamp: new Date().toISOString(),
        },
    });
});

// GET /v1/alpha/creators/breakout?source=reddit|youtube|both — optional paid endpoint
alphaRouter.get('/creators/breakout', x402Middleware, (req: Request, res: Response) => {
    const source = normalizeSource(req.query.source);
    const cards = getAllAlphaCards().filter((card) => source === 'both' || card.source === source);
    const byCreator = new Map<string, AlphaCard[]>();

    cards.forEach((card) => {
        const key = `${card.source}:${card.source_author}`;
        const existing = byCreator.get(key) || [];
        existing.push(card);
        byCreator.set(key, existing);
    });

    const breakout = Array.from(byCreator.entries())
        .map(([key, entries]) => {
            const [cardSource, author] = key.split(':');
            const avgScore = Math.round(entries.reduce((sum, card) => sum + card.alpha_score, 0) / entries.length);
            const maxScore = Math.max(...entries.map((card) => card.alpha_score));
            return {
                source: cardSource,
                author,
                cards_count: entries.length,
                avg_alpha_score: avgScore,
                peak_alpha_score: maxScore,
            };
        })
        .sort((a, b) => {
            if (b.avg_alpha_score !== a.avg_alpha_score) return b.avg_alpha_score - a.avg_alpha_score;
            return b.cards_count - a.cards_count;
        })
        .slice(0, 20);

    res.json({
        status: 200,
        source,
        breakout,
        meta: {
            protocol: 'x402',
            payment_verified: true,
            timestamp: new Date().toISOString(),
        },
    });
});

// GET /v1/alpha/cards/:id — get single card (free)
alphaRouter.get('/cards/:id', (req: Request, res: Response) => {
    const cardId = readParam(req.params.id);
    if (!cardId) {
        res.status(400).json({ error: 'Invalid alpha card id' });
        return;
    }

    const card = getAlphaCard(cardId);
    if (!card) {
        res.status(404).json({ error: 'Alpha card not found' });
        return;
    }
    res.json({ status: 200, card });
});
