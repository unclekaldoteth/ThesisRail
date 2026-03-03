import type { Metadata } from 'next';
import ClientProviders from '@/components/ClientProviders';
import './globals.css';

export const metadata: Metadata = {
  title: 'ThesisRail — From Alpha to Payout.',
  description: 'Pay-per-signal. Convert to campaign. Settle onchain. ThesisRail is the Alpha-to-Execution OS on Stacks.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <ClientProviders>
          {children}
        </ClientProviders>
      </body>
    </html>
  );
}
