import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep HEIC conversion off the edge/turbopack bundle (CJS + decode deps)
  serverExternalPackages: ['heic-convert', 'heic-decode'],
};

export default nextConfig;
