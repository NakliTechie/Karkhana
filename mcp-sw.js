/* Karkhana MCP Service Worker
 * Intercepts /mcp requests and proxies them to the live page via BroadcastChannel.
 * The page handles tool execution against the running v86 VM.
 */

const MCP_PATH = '/mcp';
const CHANNEL  = new BroadcastChannel('karkhana_mcp');
const pending  = new Map();

/* Forward MCP requests to the page */
self.addEventListener('fetch', function(event) {
    var url = new URL(event.request.url);
    if (!url.pathname.endsWith(MCP_PATH)) return;

    event.respondWith(handleMCP(event.request));
});

async function handleMCP(request) {
    /* Auth check */
    var token = await getToken();
    if (token) {
        var auth = request.headers.get('Authorization') || '';
        if (auth !== 'Bearer ' + token) {
            return new Response(JSON.stringify({ error: 'unauthorized' }), {
                status: 401, headers: { 'Content-Type': 'application/json' }
            });
        }
    }

    var body;
    try {
        body = await request.json();
    } catch (e) {
        return new Response(JSON.stringify({ error: 'invalid_json' }), {
            status: 400, headers: { 'Content-Type': 'application/json' }
        });
    }

    /* Generate correlation ID */
    var reqId = crypto.randomUUID();

    /* Send to page via BroadcastChannel */
    return new Promise(function(resolve) {
        var timer = setTimeout(function() {
            pending.delete(reqId);
            resolve(new Response(JSON.stringify({ error: 'VM not running or page closed' }), {
                status: 503, headers: { 'Content-Type': 'application/json' }
            }));
        }, 30000);

        pending.set(reqId, { resolve: resolve, timer: timer });
        CHANNEL.postMessage({ reqId: reqId, body: body });
    });
}

/* Receive responses from the page */
CHANNEL.addEventListener('message', function(event) {
    var data = event.data;
    if (!data.reqId || !pending.has(data.reqId)) return;

    var p = pending.get(data.reqId);
    pending.delete(data.reqId);
    clearTimeout(p.timer);

    p.resolve(new Response(JSON.stringify(data.result || {}), {
        status: 200,
        headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        }
    }));
});

/* Handle OPTIONS preflight */
self.addEventListener('fetch', function(event) {
    if (event.request.method === 'OPTIONS') {
        event.respondWith(new Response(null, {
            status: 204,
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type',
            }
        }));
    }
});

async function getToken() {
    /* Read token from cache (page writes it) */
    try {
        var cache = await caches.open('karkhana_config');
        var resp = await cache.match('/mcp-token');
        if (resp) return await resp.text();
    } catch (e) {}
    return null;
}

self.addEventListener('install', function() { self.skipWaiting(); });
self.addEventListener('activate', function(event) { event.waitUntil(self.clients.claim()); });
