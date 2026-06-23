import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const MULTI_SERIES_SPORTS: Record<string, string[]> = {
  worldcup: ["KXWCGAME", "KXWCSPREAD", "KXWCTOTAL"],
  mlb: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
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
    throw new Error(`Key body malformed after decode. Starts with: "${pemContent.substring(0, 30)}"`);
  }
  const der = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]);
}

async function signedHeaders(method: string, path: string, keyId: string, privateKey: CryptoKey) {
  const ts = Date.now().toString();
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    new TextEncoder().encode(ts + method.toUpperCase() + path)
  );
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
}

// ─── FETCH ────────────────────────────────────────────────────────────────────

async function kalshiFetch(path: string) {
  const res = await fetch(`${KALSHI_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Kalshi ${res.status}: ${await res.text()}`);
  return res.json();
}

async function kalshiAuth(method: string, path: string, body: unknown, keyId: string, privateKey: CryptoKey) {
  const headers = await signedHeaders(method, `/trade-api/v2${path}`, keyId, privateKey);
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Kalshi auth ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── AGENT ───────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Data", version: "1.7.0" });

  async init() {

    // PUBLIC TOOLS ─────────────────────────────────────────────────────────────

    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events for a sport. NBA bundles all markets in one event. World Cup and MLB each have THREE separate series for moneyline/spread/total. For extra props use kalshi_search_series.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        if (sport in MULTI_SERIES_SPORTS) {
          const results: Record<string, unknown> = {};
          for (const ticker of MULTI_SERIES_SPORTS[sport]) {
            results[ticker] = await kalshiFetch(`/events?series_ticker=${ticker}&status=open&with_nested_markets=true`);
          }
          return { content: [{ type: "text", text: JSON.stringify({ sport, series: results }) }] };
        }
        const data = await kalshiFetch(`/events?series_ticker=${SINGLE_SERIES_SPORTS[sport]}&status=open&with_nested_markets=true`);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi's full Sports series list by keyword to find prop series tickers (corners, goalscorer, BTTS, home runs, strikeouts, player points/rebounds/assists etc.).",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await kalshiFetch(`/series?category=Sports&limit=1000`);
        const all = (data as any).series ?? [];
        const kw = keyword.toLowerCase();
        const matches = all.filter((s: any) => (s.title ?? "").toLowerCase().includes(kw));
        return { content: [{ type: "text", text: JSON.stringify({ keyword, match_count: matches.length, matches }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_series_events",
      "Get today's open events/markets for ANY Kalshi series ticker.",
      { series_ticker: z.string() },
      async ({ series_ticker }) => {
        const data = await kalshiFetch(`/events?series_ticker=${series_ticker}&status=open&with_nested_markets=true`);
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

    // AUTH TOOL: find combo collection for a game ──────────────────────────────

    this.server.tool(
      "kalshi_get_combo_collections",
      "Find the combo collection ticker(s) available for a specific game event. Pass the event_ticker of the game (e.g. KXMLBGAME-26JUN22NYYBOS). Returns collection_tickers you can pass to kalshi_get_combo_price. Call this FIRST before kalshi_get_combo_price.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await kalshiFetch(
          `/multivariate_event_collections?event_ticker=${event_ticker}&status=open`
        );
        const collections = (data as any).multivariate_contracts ?? [];
        if (collections.length === 0) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: "no_collections",
                event_ticker,
                note: "No combo collections found for this event. It may not be combo-eligible yet — Kalshi typically adds combo collections closer to game time.",
              }),
            }],
          };
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              event_ticker,
              collections: collections.map((c: any) => ({
                collection_ticker: c.collection_ticker,
                title: c.title,
                description: c.description,
                associated_events: c.associated_events,
                size_min: c.size_min,
                size_max: c.size_max,
              })),
              next_step: "Pass collection_ticker and your chosen market legs to kalshi_get_combo_price",
            }),
          }],
        };
      }
    );

    // AUTH TOOL: get real RFQ combo price ──────────────────────────────────────

    this.server.tool(
      "kalshi_get_combo_price",
      "Submit a real Kalshi RFQ for a combo and return the live quoted price. FIRST call kalshi_get_combo_collections to get the collection_ticker for the game. Then pass the collection_ticker plus the selected_markets legs. Returns the real multiplier from a live market maker. RFQ is cancelled after pricing — no trade placed.",
      {
        collection_ticker: z.string(),
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
          return { content: [{ type: "text", text: JSON.stringify({ error: "Auth failed", detail: e.message }) }] };
        }

        // Step 1: Create the combo market in the collection
        // 409 = already exists, which is fine — Kalshi returns the ticker in the body
        let mveTicker: string;
        try {
          const res = await fetch(
            `${KALSHI_BASE}/multivariate_event_collections/${collection_ticker}`,
            {
              method: "POST",
              headers: await signedHeaders("POST", `/trade-api/v2/multivariate_event_collections/${collection_ticker}`, keyId, privateKey),
              body: JSON.stringify({ selected_markets, with_market_payload: true }),
            }
          );
          const body = await res.json() as any;
          if (res.status === 409) {
            // Market already exists — ticker is in the response body
            mveTicker = body.market_ticker ?? body.ticker ?? body.data?.market_ticker;
            if (!mveTicker) throw new Error(`409 but no ticker in body: ${JSON.stringify(body)}`);
          } else if (!res.ok) {
            throw new Error(`${res.status}: ${JSON.stringify(body)}`);
          } else {
            mveTicker = body.market_ticker ?? body.ticker;
            if (!mveTicker) throw new Error(`No ticker in 200 response: ${JSON.stringify(body)}`);
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
         const res = await kalshiAuth(
            "POST",
            "/communications/rfqs",
            { market_ticker: mveTicker, contracts_fp: contracts.toString() },
            keyId,
            privateKey
          );
          rfqId = res.id ?? res.rfq?.rfq_id ?? res.rfq_id;
          if (!rfqId) throw new Error("No RFQ ID returned: " + JSON.stringify(res));
        } catch (e: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "RFQ submission failed", detail: e.message, mve_ticker: mveTicker }) }] };
        }

// Step 3: Poll for quotes (up to 10 seconds, log raw response for debugging)
        let bestYesBid: number | null = null;
        let bestNoBid: number | null = null;
        let lastQuoteResponse: unknown = null;
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            // Primary: poll quotes filtered by this RFQ
            const res = await kalshiAuth(
              "GET",
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              null,
              keyId,
              privateKey
            );
            lastQuoteResponse = res;
            const quotes: any[] = res.quotes ?? res.data ?? [];
            for (const q of quotes) {
              // Try both dollar and integer price fields
              const ybDollars = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = ybDollars > 1
                ? Math.round(ybDollars)           // already 0-100 integer
                : Math.round(ybDollars * 100);    // decimal e.g. 0.56 → 56
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = yb;
                const nbDollars = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nbDollars > 1
                  ? Math.round(nbDollars)
                  : Math.round(nbDollars * 100);
              }
            }
            if (bestYesBid !== null) break;
          } catch (e: any) {
            lastQuoteResponse = { poll_error: e.message };
          }
        }

        // Step 4: Cancel the RFQ — price check only, no trade
        try {
          await kalshiAuth("DELETE", `/communications/rfqs/${rfqId}`, null, keyId, privateKey);
        } catch (_) {}

       if (bestYesBid === null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: "no_quote",
                rfq_id: rfqId,
                mve_ticker: mveTicker,
                legs: selected_markets.map(m => m.market_ticker),
                last_quote_response: lastQuoteResponse,
                note: "No quote price found after 10 seconds. Check last_quote_response above — if quotes array is empty, no market maker responded yet. If it has data but no price was extracted, the field names may differ.",
              }),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              result: "success",
              legs: selected_markets.map(m => m.market_ticker),
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
    if (url.pathname === "/sse" || url.pathname === "/sse/message") return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    if (url.pathname === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};
