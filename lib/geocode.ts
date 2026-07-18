export type GeocodeParts = {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
  /** Free-form fallback query */
  q?: string;
};

export type GeocodeResult = {
  point: { lat: number; lng: number };
  displayName?: string;
  source?: string;
};

/**
 * Client helper — calls our server geocode proxy (Nominatim + Photon).
 * Avoids browser CORS and applies proper User-Agent server-side.
 */
export async function geocodeAddress(
  parts: GeocodeParts
): Promise<GeocodeResult | null> {
  const street = (parts.street || '').trim();
  const city = (parts.city || '').trim();
  const state = (parts.state || '').trim();
  const zip = (parts.zip || '').trim();
  const q = (parts.q || '').trim();

  if (!street && !city && !zip && !q) return null;

  try {
    const params = new URLSearchParams();
    if (street) params.set('street', street);
    if (city) params.set('city', city);
    if (state) params.set('state', state);
    if (zip) params.set('zip', zip);
    if (q) params.set('q', q);

    const res = await fetch(`/api/geocode?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      lat?: number;
      lng?: number;
      displayName?: string;
      source?: string;
    };
    if (
      typeof data.lat !== 'number' ||
      typeof data.lng !== 'number' ||
      !Number.isFinite(data.lat) ||
      !Number.isFinite(data.lng)
    ) {
      return null;
    }
    return {
      point: { lat: data.lat, lng: data.lng },
      displayName: data.displayName,
      source: data.source,
    };
  } catch {
    return null;
  }
}
