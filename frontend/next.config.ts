import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NextConfig } from "next";

const configDir = path.dirname(fileURLToPath(import.meta.url));

const nextConfig: NextConfig = {
  // Transpile @stacks packages for SSR compatibility
  transpilePackages: ['@stacks/connect', '@stacks/transactions', '@stacks/network'],
  // Pin Turbopack workspace root so Next.js doesn't walk up to a parent lockfile.
  turbopack: {
    root: configDir,
  },
};

export default nextConfig;
