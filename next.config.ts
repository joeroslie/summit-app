import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/CJS packages off the Turbopack bundle
  serverExternalPackages: ['heic-convert', 'heic-decode', 'unpdf'],
};

export default nextConfig;
