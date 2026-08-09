import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Summit Roofing OS',
    short_name: 'Summit',
    description: 'Summit Roofing OS',
    start_url: '/',
    display: 'standalone',
    display_override: ['standalone', 'minimal-ui'],
    background_color: '#f2f3f5',
    theme_color: '#f2f3f5',
    orientation: 'any',
    icons: [
      {
        src: '/icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any',
      },
      {
        src: '/icon-maskable-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
