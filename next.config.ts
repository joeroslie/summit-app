import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/CJS packages off the Turbopack bundle
  serverExternalPackages: ['heic-convert', 'heic-decode', 'unpdf'],
  // Allow phone/other-device access to the dev server over LAN (hot-reload
  // otherwise gets blocked cross-origin, leaving the page blank on-device).
  // Keep the current LAN IP; update if Wi‑Fi lease changes.
  allowedDevOrigins: ['192.168.0.95', 'localhost'],
};

export default nextConfig;
