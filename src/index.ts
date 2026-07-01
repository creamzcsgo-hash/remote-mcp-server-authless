import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const MULTI_SERIES_SPORTS: Record<string, string[]> = {
  worldcup: [
    "KXWCGAME",    // regulation moneyline (Win/Draw/Win)
    "KXWCSPREAD",  // spread (win by X goals)
    "KXWCTOTAL",   // total goals over/under
    "KXWCSCORE",   // correct score
    "KXWCBTTS",    // both teams to score
    "KXWCTT",      // team total goals
    "KXWC1H",      // 1st half moneyline
    "KXWC1HSPREAD",// 1st half spread
    "KXWC1HTOTAL", // 1st half total
    "KXWC1HBTTS",  // 1st half BTTS
    "KXWCGOAL",    // anytime goalscorer
    "KXWCCORNERS", // corners
    "KXWCADVANCE", // advance (knockout rounds)
  ],
  mlb: [
    "KXMLBGAME",
    "KXMLBSPREAD",
    "KXMLBTOTAL",
  ],
};

const SINGLE_SERIES_SPORTS: Record<string, string> = {
  nba: "KXNBAGAME",
};

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try {
    decoded = atob(pem.trim());
  } catch {
    throw new Error(
      `KALSHI_PRIVATE_KEY is not valid base64. ` +
      `Re-encode your PEM using PowerShell and re-paste into Cloudflare. ` +
      `Value starts with: "${pem.substring(0, 40)}"`
    );
  }
  const pemContent = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(pemContent)) {
    throw new Error(`Key body malformed. Starts with: "${pemContent.substring(0, 30)}"`);
  }
  const der = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der,
    { name: "RSA-PSS", hash: "SHA-256" },
    false, ["sign"]
  );
}

async function signedHeaders(
  method: string,
  path: string,
  keyId: string,
  privateKey: CryptoKey,
  includeContentType = false
): Promise<Record<string, string>> {
  const ts = Date.now().toString();
  // CRITICAL: Kalshi signs path only — never include query string
  const pathOnly = path.split("?")[0];
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    new TextEncoder().encode(ts + method.toUpperCase() + pathOnly)
  );
  const headers: Record<string, string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
  // Only include Content-Type for requests that have a body
  if (includeContentType) headers["Content-Type"] = "application/json";
  return headers;
}

// ─── FETCH ────────────────────────────────────────────────────────────────────

async function kalshiFetch(path: string): Promise<any> {
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`Kalshi ${res.status}: ${await res.text()}`);
  return res.json();
}

async function kalshiGet(path: string, keyId: string, privateKey: CryptoKey): Promise<any> {
  const headers = await signedHeaders("GET", `/trade-api/v2${path}`, keyId, privateKey, false);
  const res = await fetch(`${KALSHI_BASE}${path}`, { method: "GET", headers });
  if (!res.ok) throw new Error(`Kalshi GET ${res.status}: ${await res.text()}`);
  return res.json();
}

async function kalshiPost(path: string, body: unknown, keyId: string, privateKey: CryptoKey): Promise<any> {
  const headers = await signedHeaders("POST", `/trade-api/v2${path}`, keyId, privateKey, true);
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Kalshi POST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function kalshiDelete(path: string, keyId: string, privateKey: CryptoKey): Promise<void> {
  const headers = await signedHeaders("DELETE", `/trade-api/v2${path}`, keyId, privateKey, false);
  await fetch(`${KALSHI_BASE}${path}`, { method: "DELETE", headers });
}

// ─── AGENT ───────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Data", version: "1.9.0" });

  async init() {

    // ── PUBLIC TOOLS ──────────────────────────────────────────────────────────

    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events for a sport. World Cup fetches all series: moneyline, spread, total, correct score, BTTS, team total, 1H markets, goalscorer, corners, advance. MLB fetches moneyline/spread/total. NBA bundles all markets. Series errors are caught individually so one missing ticker won't break the call.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        if (sport in MULTI_SERIES_SPORTS) {
          const results: Record<string, unknown> = {};
          const errors: Record<string, string> = {};
          for (const ticker of MULTI_SERIES_SPORTS[sport]) {
            try {
              results[ticker] = await kalshiFetch(
                `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
              );
            } catch (e: any) {
              errors[ticker] = e.message;
            }
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                sport,
                series: results,
                errors: Object.keys(errors).length > 0 ? errors : undefined,
              }),
            }],
          };
        }
        const data = await kalshiFetch(
          `/events?series_ticker=${SINGLE_SERIES_SPORTS[sport]}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi's full Sports series list by keyword to find any series ticker.",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await kalshiFetch(`/series?category=Sports&limit=1000`);
        const all = (data as any).series ?? [];
        const kw = keyword.toLowerCase();
        const matches = all.filter((s: any) =>
          (s.title ?? "").toLowerCase().includes(kw) ||
          (s.ticker ?? "").toLowerCase().includes(kw)
        );
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              keyword,
              match_count: matches.length,
              matches: matches.map((s: any) => ({ ticker: s.ticker, title: s.title })),
            }),
          }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_series_events",
      "Get today's open events/markets for ANY Kalshi series ticker.",
      { series_ticker: z.string() },
      async ({ series_ticker }) => {
        const data = await kalshiFetch(
          `/events?series_ticker=${series_ticker}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific Kalshi event by its event ticker.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await kalshiFetch(`/events/${event_ticker}?with_nested_markets=true`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_market",
      "Get price and volume details for a single Kalshi market ticker.",
      { market_ticker: z.string() },
      async ({ market_ticker }) => {
        const data = await kalshiFetch(`/markets/${market_ticker}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_trades",
      "Get recent trades for a Kalshi market ticker.",
      { market_ticker: z.string(), limit: z.number().optional() },
      async ({ market_ticker, limit }) => {
        const data = await kalshiFetch(`/markets/${market_ticker}/trades?limit=${limit ?? 20}`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    // ── AUTH TOOLS ────────────────────────────────────────────────────────────

    this.server.tool(
      "kalshi_get_combo_collections",
      "Find available combo collection tickers for a specific game event. Call this FIRST before kalshi_get_combo_price.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await kalshiFetch(
          `/multivariate_event_collections?event_ticker=${event_ticker}&status=open`
        );
        const collections = (data as any).multivariate_contracts ?? [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              event_ticker,
              collections: collections.map((c: any) => ({
                collection_ticker: c.collection_ticker,
                title: c.title,
                size_min: c.size_min,
                size_max: c.size_max,
              })),
              fallback: "If empty, use KXMVESPORTSMULTIGAMEEXTENDED-R as collection_ticker.",
            }),
          }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_combo_price",
      "Submit a real Kalshi RFQ for a combo and return the live quoted multiplier from market makers. RFQ is cancelled after pricing — no trade placed. Use KXMVESPORTSMULTIGAMEEXTENDED-R as default collection_ticker.",
      {
        collection_ticker: z.string().default("KXMVESPORTSMULTIGAMEEXTENDED-R"),
        selected_markets: z.array(z.object({
          market_ticker: z.string(),
          event_ticker: z.string(),
          side: z.enum(["yes", "no"]).default("yes"),
        })).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ collection_ticker, selected_markets, contracts }) => {
        let keyId: string;
        let privateKey: CryptoKey;
        try {
          keyId = this.env.KALSHI_KEY_ID;
          privateKey = await importPrivateKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: "Auth failed", detail: e.message }),
            }],
          };
        }

        // Step 1: Create or retrieve MVE market (409 = already exists, reuse it)
        let mveTicker: string;
        try {
          const mveHeaders = await signedHeaders(
            "POST",
            `/trade-api/v2/multivariate_event_collections/${collection_ticker}`,
            keyId, privateKey, true
          );
          const mveRes = await fetch(
            `${KALSHI_BASE}/multivariate_event_collections/${collection_ticker}`,
            {
              method: "POST",
              headers: mveHeaders,
              body: JSON.stringify({ selected_markets, with_market_payload: true }),
            }
          );
          const mveBody = await mveRes.json() as any;
          if (mveRes.status === 409) {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker ?? mveBody.data?.market_ticker;
            if (!mveTicker) throw new Error(`409 but no ticker in body: ${JSON.stringify(mveBody)}`);
          } else if (!mveRes.ok) {
            throw new Error(`${mveRes.status}: ${JSON.stringify(mveBody)}`);
          } else {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker;
            if (!mveTicker) throw new Error(`No ticker in response: ${JSON.stringify(mveBody)}`);
          }
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Could not create or retrieve combo market",
                detail: e.message,
                collection_ticker,
                selected_markets,
              }),
            }],
          };
        }

        // Step 2: Submit RFQ
        let rfqId: string;
        try {
          const rfqRes = await kalshiPost(
            "/communications/rfqs",
            { market_ticker: mveTicker, contracts_fp: contracts.toString() },
            keyId, privateKey
          );
          rfqId = rfqRes.id ?? rfqRes.rfq?.rfq_id ?? rfqRes.rfq_id;
          if (!rfqId) throw new Error("No RFQ ID: " + JSON.stringify(rfqRes));
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ error: "RFQ submission failed", detail: e.message, mve_ticker: mveTicker }),
            }],
          };
        }

        // Step 3: Poll for quotes (up to 10 seconds)
        // GET requests sign path only — no query string in signature
        let bestYesBid: number | null = null;
        let bestNoBid: number | null = null;
        let lastResponse: unknown = null;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const quotesRes = await kalshiGet(
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              keyId, privateKey
            );
            lastResponse = quotesRes;
            const quotes: any[] = quotesRes.quotes ?? quotesRes.data ?? [];
            for (const q of quotes) {
              const ybRaw = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = ybRaw > 1 ? Math.round(ybRaw) : Math.round(ybRaw * 100);
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = yb;
                const nbRaw = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nbRaw > 1 ? Math.round(nbRaw) : Math.round(nbRaw * 100);
              }
            }
            if (bestYesBid !== null) break;
          } catch (e: any) {
            lastResponse = { poll_error: e.message };
          }
        }

        // Step 4: Cancel RFQ — price check only
        try {
          await kalshiDelete(`/communications/rfqs/${rfqId}`, keyId, privateKey);
        } catch (_) {}

        if (bestYesBid === null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: "no_quote",
                rfq_id: rfqId,
                mve_ticker: mveTicker,
                legs: selected_markets.map((m) => m.market_ticker),
                last_response: lastResponse,
                note: "No market maker quote in 10 seconds. Try again 1-2 hours before game time.",
              }),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              result: "success",
              legs: selected_markets.map((m) => m.market_ticker),
              mve_ticker: mveTicker,
              yes_bid: bestYesBid,
              no_bid: bestNoBid,
              multiplier: `${(100 / bestYesBid).toFixed(2)}x`,
              note: "REAL Kalshi RFQ price from a live market maker. RFQ cancelled — no trade was placed.",
            }),
          }],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message") {
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    }
    if (url.pathname === "/mcp") {
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    }
    return new Response("Not found", { status: 404 });
  },
};
