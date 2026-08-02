import { NextRequest, NextResponse } from 'next/server';
import convert from 'heic-convert';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  try {
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'No file' }, { status: 400 });
    }

    const inputBuffer = Buffer.from(await file.arrayBuffer());
    const outputBuffer = await convert({
      buffer: inputBuffer,
      format: 'JPEG',
      quality: 0.85,
    });

    return new NextResponse(new Uint8Array(outputBuffer), {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('convert-heic error:', err);
    const message = err instanceof Error ? err.message : 'Convert failed';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
