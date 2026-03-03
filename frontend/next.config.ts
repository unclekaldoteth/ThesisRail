import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Transpile @stacks packages for SSR compatibility
  transpilePackages: ['@stacks/connect', '@stacks/transactions', '@stacks/network'],
  // Empty turbopack config to satisfy Next.js 16
  turbopack: {},
};

export default nextConfig;
