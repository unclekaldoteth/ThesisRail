/**
 * Alpha Scoring Engine
 * Converts raw social data into scored Alpha Cards with thesis, catalyst, risks, and invalidation rules.
 */

import { v4 as uuidv4 } from 'uuid';
import { RedditPost } from '../ingestion/reddit';
import { YouTubeVideo } from '../ingestion/youtube';

export interface AlphaCard {
    id: string;
    alpha_score: number;
    thesis: string;
    catalyst: string;
    time_window: string;
    evidence_links: string[];
    risks: string[];
    invalidation_rule: string;
    content_angles: string[];
    source: 'reddit' | 'youtube';
    source_title: string;
    source_author: string;
    created_at: string;
}

// Keyword sets for scoring relevance
const HIGH_VALUE_KEYWORDS = [
    'catalyst', 'breakout', 'thesis', 'narrative', 'undervalued', 'accumulation',
    'institutional', 'launch', 'mainnet', 'partnership', 'upgrade', 'tokenomics',
    'airdrop', 'sBTC', 'layer 2', 'RWA', 'AI agent', 'DePIN', 'restaking',
    'liquid staking', 'cross-chain', 'interoperability', 'zero knowledge', 'zk',
];

const RISK_KEYWORDS = [
    'risk', 'concern', 'warning', 'bearish', 'overvalued', 'dump', 'regulation',
    'hack', 'exploit', 'vulnerability', 'delay', 'legal', 'SEC',
];

function calculateAlphaScore(
    engagementScore: number,
    recencyHours: number,
    keywordHits: number,
    hasSubstance: boolean
): number {
    let score = 0;

    // Engagement component (0-40)
    score += Math.min(40, Math.log2(engagementScore + 1) * 5);

    // Recency boost (0-25)
    if (recencyHours <= 6) score += 25;
    else if (recencyHours <= 12) score += 20;
    else if (recencyHours <= 24) score += 15;
    else if (recencyHours <= 72) score += 8;
    else score += 3;

    // Keyword relevance (0-25)
    score += Math.min(25, keywordHits * 5);

    // Substance bonus (0-10)
    if (hasSubstance) score += 10;

    return Math.min(100, Math.round(score));
}

function extractThesis(title: string, body: string): string {
    // Extract a concise thesis from title and body
    const combined = `${title}. ${body}`;
    const sentences = combined.split(/[.!?]+/).filter((s) => s.trim().length > 20);
    const thesis = sentences[0]?.trim() || title;
    return thesis.length > 150 ? thesis.substring(0, 147) + '...' : thesis;
}

function extractCatalyst(title: string, body: string): string {
    const combined = `${title} ${body}`.toLowerCase();
    const catalystPatterns = [
        /launch(?:ing|ed)?\s+([^.]+)/i,
        /upgrad(?:e|ing)\s+([^.]+)/i,
        /partner(?:ship|ed|ing)\s+(?:with\s+)?([^.]+)/i,
        /announc(?:ed?|ing)\s+([^.]+)/i,
        /releas(?:e|ing|ed)\s+([^.]+)/i,
    ];

    for (const pattern of catalystPatterns) {
        const match = combined.match(pattern);
        if (match) return match[0].trim().substring(0, 100);
    }

    return 'Market attention and community engagement trending upward';
}

function generateRisks(body: string): string[] {
    const risks: string[] = [];
    const lower = body.toLowerCase();

    if (RISK_KEYWORDS.some((k) => lower.includes(k))) {
        risks.push('Identified risk signals in source material');
    }

    risks.push('Narrative may not translate to price action');
    risks.push('Timing uncertainty — catalyst window may extend or compress');

    return risks;
}

function generateInvalidationRule(thesis: string): string {
    return `Thesis invalidated if: core narrative fails to gain traction within the stated time window, or if counter-evidence emerges from primary sources.`;
}

function generateContentAngles(title: string): string[] {
    return [
        `Thread: Break down "${title.substring(0, 60)}..." for non-technical audience`,
        `Comparison post: This signal vs competing narratives`,
        `Risk analysis: What could go wrong and contingency positions`,
    ];
}

export function scoreRedditPost(post: RedditPost, window: string): AlphaCard {
    const hoursAgo = (Date.now() / 1000 - post.created_utc) / 3600;
    const combined = `${post.title} ${post.selftext}`.toLowerCase();
    const keywordHits = HIGH_VALUE_KEYWORDS.filter((k) => combined.includes(k)).length;
    const hasSubstance = post.selftext.length > 100;
    const engagement = post.score + post.num_comments * 3;

    const alphaScore = calculateAlphaScore(engagement, hoursAgo, keywordHits, hasSubstance);
    const thesis = extractThesis(post.title, post.selftext);

    return {
        id: uuidv4(),
        alpha_score: alphaScore,
        thesis,
        catalyst: extractCatalyst(post.title, post.selftext),
        time_window: window,
        evidence_links: [post.permalink],
        risks: generateRisks(post.selftext),
        invalidation_rule: generateInvalidationRule(thesis),
        content_angles: generateContentAngles(post.title),
        source: 'reddit',
        source_title: post.title,
        source_author: post.author,
        created_at: new Date(post.created_utc * 1000).toISOString(),
    };
}

export function scoreYouTubeVideo(video: YouTubeVideo, window: string): AlphaCard {
    const publishedAt = new Date(video.publishedAt).getTime();
    const hoursAgo = (Date.now() - publishedAt) / 3600000;
    const combined = `${video.title} ${video.description}`.toLowerCase();
    const keywordHits = HIGH_VALUE_KEYWORDS.filter((k) => combined.includes(k)).length;
    const hasSubstance = video.description.length > 100;

    const alphaScore = calculateAlphaScore(video.viewCount, hoursAgo, keywordHits, hasSubstance);
    const thesis = extractThesis(video.title, video.description);

    return {
        id: uuidv4(),
        alpha_score: alphaScore,
        thesis,
        catalyst: extractCatalyst(video.title, video.description),
        time_window: window,
        evidence_links: [video.url],
        risks: generateRisks(video.description),
        invalidation_rule: generateInvalidationRule(thesis),
        content_angles: generateContentAngles(video.title),
        source: 'youtube',
        source_title: video.title,
        source_author: video.channelTitle,
        created_at: video.publishedAt,
    };
}
