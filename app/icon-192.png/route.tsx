import { ImageResponse } from 'next/og';

export const dynamic = 'force-static';

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
          borderRadius: 40,
        }}
      >
        <span
          style={{
            color: '#fff',
            fontSize: 108,
            fontWeight: 700,
            letterSpacing: '-0.04em',
            fontFamily: 'system-ui, -apple-system, sans-serif',
          }}
        >
          S
        </span>
      </div>
    ),
    { width: 192, height: 192 }
  );
}
