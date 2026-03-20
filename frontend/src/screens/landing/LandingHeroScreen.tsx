'use client';

import Link from 'next/link';
import Image from 'next/image';

const EXPLORER_URL =
  'https://explorer.hiro.so/address/ST1ZGGS886YCZHMFXJR1EK61ZP34FNWNSX28M1PMM.thesis-rail-escrow-v7?chain=testnet';

const FLOW_STEPS = [
  {
    number: '01',
    title: 'Discover',
    accent: 'var(--accent-secondary)',
    accentDim: 'var(--accent-secondary-dim)',
    icon: '⚡',
    description:
      'Aggregate alpha signals from Reddit & YouTube. AI-scored with engagement, recency, and keyword relevance. Gated by x402 pay-per-request.',
    tags: ['Reddit', 'YouTube', 'x402', 'AI Scoring'],
  },
  {
    number: '02',
    title: 'Campaign',
    accent: 'var(--accent-warning)',
    accentDim: 'var(--accent-warning-dim)',
    icon: '⟁',
    description:
      'Convert signals into milestone-based content campaigns. Edit work orders, set payouts, and deploy escrow — all enforced by a Clarity smart contract.',
    tags: ['Milestones', 'Escrow', 'Clarity', 'Work Orders'],
  },
  {
    number: '03',
    title: 'Settle',
    accent: 'var(--accent-primary)',
    accentDim: 'var(--accent-primary-dim)',
    icon: '✓',
    description:
      'Executors claim tasks, submit proof, and owners approve. USDCx payout transfers automatically from the on-chain escrow on Stacks.',
    tags: ['USDCx', 'Stacks', 'Payout', 'On-chain'],
  },
];

const TECH_BADGES = ['Stacks', 'x402', 'Clarity 4', 'USDCx', 'Next.js', 'Hiro Wallet'];

export default function LandingHeroScreen() {
  return (
    <div className="hero-landing">
      {/* Hero section */}
      <section className="hero-section">
        <div className="hero-glow" />

        <div className="hero-logo-wrap hero-fade-in" style={{ animationDelay: '0.1s' }}>
          <Image
            src="/thesisrail_logo.png"
            alt="ThesisRail"
            width={100}
            height={100}
            className="hero-logo-img"
            priority
          />
        </div>

        <h1 className="hero-heading hero-fade-in" style={{ animationDelay: '0.25s' }}>
          From Alpha Signal
          <br />
          <span className="hero-heading-accent">→ to Onchain Escrow Payout</span>
        </h1>

        <p className="hero-subheading hero-fade-in" style={{ animationDelay: '0.4s' }}>
          Pay-per-signal. Convert to campaign. Settle onchain.
        </p>

        <div className="hero-cta-row hero-fade-in" style={{ animationDelay: '0.55s' }}>
          <Link href="/alpha" className="btn btn-primary btn-lg hero-cta-primary">
            Launch App →
          </Link>
          <a
            href={EXPLORER_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary btn-lg"
          >
            View on Testnet
          </a>
        </div>

        <p className="hero-network-label hero-fade-in" style={{ animationDelay: '0.65s' }}>
          Deployed on Stacks Testnet · thesis-rail-escrow-v7
        </p>
      </section>

      {/* 3-Step Flow */}
      <section className="hero-flow-section">
        <h2 className="hero-section-title hero-fade-in" style={{ animationDelay: '0.7s' }}>
          How It Works
        </h2>
        <p className="hero-section-subtitle hero-fade-in" style={{ animationDelay: '0.75s' }}>
          Three steps from social signal to on-chain settlement
        </p>

        <div className="hero-flow-grid">
          {FLOW_STEPS.map((step, i) => (
            <div
              key={step.number}
              className="hero-flow-card hero-fade-in"
              style={{
                animationDelay: `${0.8 + i * 0.15}s`,
                '--card-accent': step.accent,
                '--card-accent-dim': step.accentDim,
              } as React.CSSProperties}
            >
              <div className="hero-flow-card-top">
                <span className="hero-flow-number">{step.number}</span>
                <span className="hero-flow-icon">{step.icon}</span>
              </div>
              <h3 className="hero-flow-title">{step.title}</h3>
              <p className="hero-flow-description">{step.description}</p>
              <div className="hero-flow-tags">
                {step.tags.map((tag) => (
                  <span key={tag} className="hero-flow-tag">
                    {tag}
                  </span>
                ))}
              </div>
              {i < FLOW_STEPS.length - 1 && <div className="hero-flow-connector" />}
            </div>
          ))}
        </div>
      </section>

      {/* Tech Stack Bar */}
      <section className="hero-tech-section hero-fade-in" style={{ animationDelay: '1.3s' }}>
        <div className="hero-tech-bar">
          {TECH_BADGES.map((badge) => (
            <span key={badge} className="hero-tech-badge">
              {badge}
            </span>
          ))}
        </div>
      </section>

      {/* DoraHacks Footer */}
      <footer className="hero-footer hero-fade-in" style={{ animationDelay: '1.4s' }}>
        <div className="hero-footer-inner">
          <span className="hero-dorahacks-badge">Built for DoraHacks Hackathon</span>
          <span className="hero-footer-divider">·</span>
          <span className="hero-footer-tagline">
            ThesisRail — The Alpha-to-Execution OS on Stacks
          </span>
        </div>
      </footer>
    </div>
  );
}
