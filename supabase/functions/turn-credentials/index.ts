// Hands out short-lived TURN relay credentials for video calls, only to signed-in users.
// The Metered.ca API key stays a server-side secret (set it in Supabase → Edge Functions → Secrets):
//   METERED_API_KEY  – from metered.ca → TURN Server → Credentials / API key
//   METERED_DOMAIN   – your app domain, e.g. "virtualhookah.metered.live"
// Supabase verifies the caller's JWT before this code runs (verify_jwt = true).

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'private, max-age=300' } });

let cache: { at: number; servers: unknown } | null = null;

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  const key = Deno.env.get('METERED_API_KEY');
  const domain = Deno.env.get('METERED_DOMAIN');
  if (!key || !domain || !/^[a-z0-9-]+\.metered\.live$/.test(domain)) return json({ iceServers: [], configured: false });
  if (cache && Date.now() - cache.at < 10 * 60 * 1000) return json({ iceServers: cache.servers, configured: true });
  try {
    const r = await fetch(`https://${domain}/api/v1/turn/credentials?apiKey=${encodeURIComponent(key)}`);
    if (!r.ok) return json({ iceServers: [], configured: true, error: `relay ${r.status}` }, 502);
    const servers = await r.json();
    cache = { at: Date.now(), servers };
    return json({ iceServers: servers, configured: true });
  } catch (e) {
    return json({ iceServers: [], configured: true, error: String(e) }, 502);
  }
});
