/**
 * YouTube Ingestion Module
 * Fetches crypto/web3 related videos for alpha signal discovery.
 * Uses YouTube Data API v3 if key available, otherwise returns mock data.
 */

export interface YouTubeVideo {
    id: string;
    title: string;
    description: string;
    channelTitle: string;
    publishedAt: string;
    viewCount: number;
    thumbnail: string;
    url: string;
}

const SEARCH_QUERIES = [
    'crypto alpha signals',
    'web3 trends analysis',
    'DeFi opportunities',
    'blockchain narrative',
    'crypto market analysis',
];

interface YouTubeSearchItem {
    id?: {
        videoId?: unknown;
    };
    snippet?: {
        title?: unknown;
        description?: unknown;
        channelTitle?: unknown;
        publishedAt?: unknown;
        thumbnails?: {
            high?: { url?: unknown };
            default?: { url?: unknown };
        };
    };
}

interface YouTubeSearchResponse {
    items?: YouTubeSearchItem[];
}

function asString(value: unknown, fallback: string = ''): string {
    return typeof value === 'string' ? value : fallback;
}

async function fetchYouTubeAPI(query: string, apiKey: string, limit: number): Promise<YouTubeVideo[]> {
    try {
        const searchUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&type=video&order=date&maxResults=${limit}&key=${apiKey}`;
        const searchRes = await fetch(searchUrl);

        if (!searchRes.ok) {
            console.warn(`[YouTube] API error: ${searchRes.status}`);
            return [];
        }

        const searchData = (await searchRes.json()) as YouTubeSearchResponse;
        const items = Array.isArray(searchData.items) ? searchData.items : [];

        const videos: YouTubeVideo[] = items
            .map((item) => {
                const videoId = asString(item.id?.videoId);
                if (!videoId) return null;

                const snippet = item.snippet ?? {};
                const title = asString(snippet.title, 'Untitled');
                const description = asString(snippet.description).substring(0, 300);
                const channelTitle = asString(snippet.channelTitle, 'Unknown Channel');
                const publishedAt = asString(snippet.publishedAt, new Date().toISOString());
                const thumbnail = asString(snippet.thumbnails?.high?.url) || asString(snippet.thumbnails?.default?.url);

                return {
                    id: videoId,
                    title,
                    description,
                    channelTitle,
                    publishedAt,
                    viewCount: 0, // Would need a separate statistics call
                    thumbnail,
                    url: `https://youtube.com/watch?v=${videoId}`,
                };
            })
            .filter((video): video is YouTubeVideo => video !== null);

        return videos;
    } catch (error) {
        console.error(`[YouTube] Error:`, error);
        return [];
    }
}

function getMockVideos(): YouTubeVideo[] {
    return [
        {
            id: 'mock-yt-1',
            title: 'BTC Layer 2 Thesis: Why Stacks Is Positioned for Breakout',
            description: 'Deep analysis of Bitcoin L2 ecosystem with focus on Stacks sBTC launch and its implications for DeFi on Bitcoin. Key catalysts and risk framework included.',
            channelTitle: 'CryptoAlpha Research',
            publishedAt: new Date(Date.now() - 6 * 3600000).toISOString(),
            viewCount: 42000,
            thumbnail: 'https://i.ytimg.com/vi/placeholder/hqdefault.jpg',
            url: 'https://youtube.com/watch?v=mock-yt-1',
        },
        {
            id: 'mock-yt-2',
            title: 'AI x Crypto Convergence — 5 Undervalued Protocols',
            description: 'Breaking down the intersection of AI agents and on-chain infrastructure. Analysis of compute networks, data availability layers, and decentralized inference.',
            channelTitle: 'DeFi Edge',
            publishedAt: new Date(Date.now() - 12 * 3600000).toISOString(),
            viewCount: 38500,
            thumbnail: 'https://i.ytimg.com/vi/placeholder2/hqdefault.jpg',
            url: 'https://youtube.com/watch?v=mock-yt-2',
        },
        {
            id: 'mock-yt-3',
            title: 'Onchain Reputation Systems — The Next Narrative?',
            description: 'Examining how identity and reputation are being built on-chain. Projects building attestation layers and their potential for content monetization.',
            channelTitle: 'Blockchain Bureau',
            publishedAt: new Date(Date.now() - 18 * 3600000).toISOString(),
            viewCount: 15200,
            thumbnail: 'https://i.ytimg.com/vi/placeholder3/hqdefault.jpg',
            url: 'https://youtube.com/watch?v=mock-yt-3',
        },
        {
            id: 'mock-yt-4',
            title: 'RWA Tokenization Thesis — Institutional Money Entering DeFi',
            description: 'Real World Assets tokenization is accelerating with BlackRock, Ondo, and others entering the space. What this means for DeFi yields and protocol positioning.',
            channelTitle: 'InstitutionalCrypto',
            publishedAt: new Date(Date.now() - 24 * 3600000).toISOString(),
            viewCount: 67800,
            thumbnail: 'https://i.ytimg.com/vi/placeholder4/hqdefault.jpg',
            url: 'https://youtube.com/watch?v=mock-yt-4',
        },
        {
            id: 'mock-yt-5',
            title: 'Pay-Per-Use APIs: x402 Protocol and the Future of Monetization',
            description: 'Analysis of Coinbase x402 protocol and how HTTP 402 Payment Required enables new business models for AI agents and APIs.',
            channelTitle: 'Web3 Builders',
            publishedAt: new Date(Date.now() - 8 * 3600000).toISOString(),
            viewCount: 21300,
            thumbnail: 'https://i.ytimg.com/vi/placeholder5/hqdefault.jpg',
            url: 'https://youtube.com/watch?v=mock-yt-5',
        },
    ];
}

export async function fetchYouTubeAlpha(window: string = '24h', limit: number = 10): Promise<YouTubeVideo[]> {
    const apiKey = process.env.YOUTUBE_API_KEY;

    if (apiKey) {
        const perQuery = Math.ceil(limit / SEARCH_QUERIES.length);
        const promises = SEARCH_QUERIES.slice(0, 3).map((q) => fetchYouTubeAPI(q, apiKey, perQuery));
        const results = await Promise.all(promises);
        const allVideos = results.flat();
        return allVideos.slice(0, limit);
    }

    // Fallback: mock data for demo
    console.log('[YouTube] No API key — using mock data');
    return getMockVideos().slice(0, limit);
}
