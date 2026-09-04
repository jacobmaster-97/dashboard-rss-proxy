import { DurableObject } from 'cloudflare:workers';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 12000;

function marketSymbols(env) {
  return (env.MARKET_SYMBOLS || 'MU,VTI').split(',').map(symbol => symbol.trim().toUpperCase()).filter(Boolean).slice(0, 20);
}

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

    if (reqUrl.pathname === '/market' || reqUrl.pathname === '/market/snapshot') {
      if (!env.MARKET_STREAM) {
        return jsonResponse(request, env, { ok: false, error: 'Market stream is not configured.' }, 503);
      }
      if (reqUrl.pathname === '/market' && request.headers.get('Upgrade') !== 'websocket') {
        return jsonResponse(request, env, { ok: false, error: 'WebSocket upgrade required.' }, 426);
      }
      const response = await env.MARKET_STREAM.getByName('dashboard-market-stream-v1').fetch(request);
      if (reqUrl.pathname === '/market') return response;
      const headers = new Headers(response.headers);
      for (const [name, value] of Object.entries(cors)) headers.set(name, value);
      return new Response(response.body, { status: response.status, headers });
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

// A single Durable Object keeps one upstream Finnhub subscription for all open dashboards.
export class MarketStream extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.clients = new Set();
    this.quotes = new Map();
    this.upstream = null;
    this.reconnectTimer = null;
    this.upstreamStarting = null;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/market/snapshot') {
      try {
        await this.refreshSnapshot();
        return this.json({ ok: true, quotes: this.quoteList(), updatedAt: Date.now() });
      } catch (error) {
        console.error('Market snapshot failed', error);
        return this.json({ ok: false, error: error.message || 'Market snapshot unavailable.' }, 503);
      }
    }
    if (url.pathname !== '/market' || request.headers.get('Upgrade') !== 'websocket') return this.json({ ok: false, error: 'Not found.' }, 404);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.clients.add(server);
    server.addEventListener('close', () => this.removeClient(server));
    server.addEventListener('error', () => this.removeClient(server));
    this.send(server, { type: 'snapshot', quotes: this.quoteList(), updatedAt: Date.now() });
    this.ctx.waitUntil(this.ensureStarted());
    return new Response(null, { status: 101, webSocket: client });
  }

  json(data, status = 200) {
    return new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });
  }

  quoteList() { return [...this.quotes.values()].sort((a, b) => a.symbol.localeCompare(b.symbol)); }

  async refreshSnapshot() {
    const token = this.env.FINNHUB_API_KEY;
    if (!token) throw new Error('FINNHUB_API_KEY is not configured.');
    await Promise.all(marketSymbols(this.env).map(async symbol => {
      const response = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(token)}`, { headers: { Accept: 'application/json' }, cf: { cacheTtl: 0, cacheEverything: false } });
      if (!response.ok) throw new Error(`Finnhub quote for ${symbol} returned ${response.status}.`);
      const quote = await response.json();
      if (!Number.isFinite(quote.c) || quote.c === 0) return;
      const existing = this.quotes.get(symbol);
      this.quotes.set(symbol, { symbol, price: quote.c, change: Number(quote.d || 0), percent: Number(quote.dp || 0), tradeAt: existing?.tradeAt || Number(quote.t || 0) * 1000 || Date.now() });
    }));
  }

  async ensureStarted() {
    if (!this.env.FINNHUB_API_KEY) {
      this.broadcast({ type: 'error', error: 'Market stream is not configured.' });
      return;
    }
    try {
      await this.refreshSnapshot();
      this.broadcast({ type: 'snapshot', quotes: this.quoteList(), updatedAt: Date.now() });
    } catch (error) {
      console.error('Market snapshot failed', error);
      this.broadcast({ type: 'error', error: 'Unable to load market snapshot.' });
    }
    this.connectUpstream();
  }

  connectUpstream() {
    if (this.upstream || this.upstreamStarting || this.clients.size === 0) return;
    this.upstreamStarting = Promise.resolve().then(() => {
      const upstream = new WebSocket(`wss://ws.finnhub.io?token=${encodeURIComponent(this.env.FINNHUB_API_KEY)}`);
      this.upstream = upstream;
      upstream.addEventListener('open', () => marketSymbols(this.env).forEach(symbol => upstream.send(JSON.stringify({ type: 'subscribe', symbol }))));
      upstream.addEventListener('message', event => this.handleUpstreamMessage(event.data));
      upstream.addEventListener('error', error => console.error('Finnhub WebSocket error', error));
      upstream.addEventListener('close', () => {
        if (this.upstream !== upstream) return;
        this.upstream = null;
        this.scheduleReconnect();
      });
    }).catch(error => {
      this.upstream = null;
      console.error('Unable to connect Finnhub WebSocket', error);
      this.scheduleReconnect();
    }).finally(() => { this.upstreamStarting = null; });
  }

  handleUpstreamMessage(raw) {
    let message;
    try { message = JSON.parse(raw); } catch { return; }
    if (message.type !== 'trade' || !Array.isArray(message.data)) return;
    for (const trade of message.data) {
      const symbol = String(trade.s || '').toUpperCase();
      if (!marketSymbols(this.env).includes(symbol) || !Number.isFinite(trade.p)) continue;
      const previous = this.quotes.get(symbol) || { symbol, change: 0, percent: 0 };
      const quote = { ...previous, symbol, price: trade.p, tradeAt: Number(trade.t) || Date.now() };
      this.quotes.set(symbol, quote);
      this.broadcast({ type: 'trade', quote });
    }
  }

  send(socket, message) { try { socket.send(JSON.stringify(message)); } catch { this.removeClient(socket); } }
  broadcast(message) { for (const client of this.clients) this.send(client, message); }

  removeClient(client) {
    this.clients.delete(client);
    if (this.clients.size === 0) this.ctx.waitUntil(this.ctx.storage.setAlarm(Date.now() + 60_000));
  }

  async alarm() {
    if (this.clients.size > 0) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.upstream) {
      const upstream = this.upstream;
      this.upstream = null;
      try { upstream.close(1000, 'No dashboard clients'); } catch {}
    }
  }

  scheduleReconnect() {
    if (this.clients.size === 0 || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectUpstream();
    }, 3000);
  }
}
