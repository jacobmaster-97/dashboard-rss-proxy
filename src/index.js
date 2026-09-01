const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

function corsHeaders(request, env) {
  const requestOrigin = request.headers.get('Origin');
  const configured = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean);

  let allowOrigin = '*';
  if (!configured.includes('*')) {
    allowOrigin = requestOrigin && configured.includes(requestOrigin) ? requestOrigin : '';
  }

  return {
    'Access-Control-Allow-Origin': allowOrigin || 'null',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(request, env, data, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      ...corsHeaders(request, env),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
    },
  });
}

function isHongKongArea(latitude, longitude) {
  return Number.isFinite(latitude) && Number.isFinite(longitude) &&
    latitude >= 21.8 && latitude <= 22.7 &&
    longitude >= 113.8 && longitude <= 114.6;
}

function isPrivateIpv4(host) {
  const m = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const octets = m.slice(1).map(Number);
  if (octets.some(n => n < 0 || n > 255)) return true;
  const [a, b] = octets;
  return (
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host.startsWith('[')) return true;
  return isPrivateIpv4(host);
}

function validateTarget(rawUrl, workerHost) {
  let target;
  try {
    target = new URL(rawUrl);
  } catch {
    return { error: 'Invalid RSS URL.' };
  }

  if (!['http:', 'https:'].includes(target.protocol)) {
    return { error: 'Only http:// and https:// RSS URLs are allowed.' };
  }
  if (target.username || target.password) {
    return { error: 'URLs containing username/password are not allowed.' };
  }
  if (isBlockedHost(target.hostname)) {
    return { error: 'Local/private network targets are not allowed.' };
  }
  if (target.hostname === workerHost) {
    return { error: 'Proxy loop is not allowed.' };
  }
  if (target.port && !['80', '443'].includes(target.port)) {
    return { error: 'Only standard web ports 80/443 are allowed.' };
  }
  return { target };
}

function looksLikeFeed(contentType, textStart) {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('rss') || ct.includes('atom') || ct.includes('xml')) return true;
  const s = (textStart || '').toLowerCase();
  return s.includes('<rss') || s.includes('<feed') || s.includes('<rdf:rdf') || s.includes('<?xml');
}

async function readLimited(response, maxBytes) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new Error('RSS response is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }

    const allowedOrigins = (env.ALLOWED_ORIGINS || '*').split(',').map(v => v.trim());
    const origin = request.headers.get('Origin');
    if (!allowedOrigins.includes('*') && origin && !allowedOrigins.includes(origin)) {
      return jsonResponse(request, env, { ok: false, error: 'Origin not allowed.' }, 403);
    }

    if (!['GET', 'HEAD'].includes(request.method)) {
      return jsonResponse(request, env, { ok: false, error: 'Method not allowed.' }, 405);
    }

    if (reqUrl.pathname === '/location') {
      const cf = request.cf || {};
      const latitude = Number(cf.latitude);
      const longitude = Number(cf.longitude);
      const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
      const inHongKongArea = hasCoordinates && isHongKongArea(latitude, longitude);
      return jsonResponse(request, env, {
        ok: inHongKongArea,
        source: 'cloudflare-network',
        latitude: inHongKongArea ? latitude : null,
        longitude: inHongKongArea ? longitude : null,
        city: cf.city || '',
        region: cf.region || '',
        country: cf.country || '',
        reason: inHongKongArea ? null : (hasCoordinates ? 'outside-hong-kong' : 'coordinates-unavailable'),
      });
    }

    if (reqUrl.pathname === '/' || reqUrl.pathname === '/health') {
      return jsonResponse(request, env, {
        ok: true,
        service: 'dashboard-rss-proxy',
        usage: '/rss?url=https%3A%2F%2Fexample.com%2Ffeed.xml',
        cache: 'disabled',
      });
    }

    if (reqUrl.pathname !== '/rss') {
      return jsonResponse(request, env, { ok: false, error: 'Not found.' }, 404);
    }

    const rawTarget = reqUrl.searchParams.get('url') || '';
    const check = validateTarget(rawTarget, reqUrl.hostname);
    if (check.error) {
      return jsonResponse(request, env, { ok: false, error: check.error }, 400);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort('timeout'), FETCH_TIMEOUT_MS);

    try {
      const upstream = await fetch(check.target.toString(), {
        method: 'GET',
        redirect: 'follow',
        cache: 'no-store',
        signal: controller.signal,
        headers: {
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8',
        },
      });

      if (!upstream.ok) {
        return jsonResponse(request, env, {
          ok: false,
          error: `Upstream returned HTTP ${upstream.status}.`,
        }, 502);
      }

      const contentLength = Number(upstream.headers.get('Content-Length') || 0);
      const maxBytes = Number(env.MAX_BYTES || DEFAULT_MAX_BYTES);
      if (contentLength && contentLength > maxBytes) {
        return jsonResponse(request, env, { ok: false, error: 'RSS response is too large.' }, 413);
      }

      const bytes = await readLimited(upstream, maxBytes);
      const decoder = new TextDecoder('utf-8');
      const preview = decoder.decode(bytes.slice(0, 4096));
      const upstreamType = upstream.headers.get('Content-Type') || 'application/xml; charset=utf-8';

      if (!looksLikeFeed(upstreamType, preview)) {
        return jsonResponse(request, env, {
          ok: false,
          error: 'The target did not return RSS/Atom/XML content.',
        }, 415);
      }

      return new Response(request.method === 'HEAD' ? null : bytes, {
        status: 200,
        headers: {
          ...cors,
          'Content-Type': upstreamType,
          'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
          'CDN-Cache-Control': 'no-store',
          'X-RSS-Proxy': 'cloudflare-worker',
          'X-RSS-Source': check.target.hostname,
          'X-Content-Type-Options': 'nosniff',
        },
      });
    } catch (error) {
      const msg = error?.name === 'AbortError' ? 'RSS request timed out.' : (error?.message || 'RSS fetch failed.');
      return jsonResponse(request, env, { ok: false, error: msg }, 504);
    } finally {
      clearTimeout(timer);
    }
  },
};
