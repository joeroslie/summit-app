import { ImageResponse } from 'next/og';

export const dynamic = 'force-static';

/** Maskable icon: full-bleed background, mark kept inside the ~80% safe-zone circle. */
export async function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#18181b',
        }}
      >
        <span
          style={{
            color: '#fff',
            fontSize: 220,
            fontWeight: 700,
            letterSpacing: '-0.04em',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          S
        </span>
      </div>
    ),
    { width: 512, height: 512 }
  );
}
