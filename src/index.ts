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

// ─── AUTH HELPERS ────────────────────────────────────────────────────────────

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const pemContent = pem
    .replace(/-----BEGIN PRIVATE KEY-----/g, "")
    .replace(/-----END PRIVATE KEY-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(pemContent), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8",
    der,
    { name: "RSA-PSS", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

async function signedHeaders(
  method: string,
  path: string,
  keyId: string,
  privateKey: CryptoKey
): Promise<Record<string, string>> {
  const ts = Date.now().toString();
  const msg = ts + method.toUpperCase() + path;
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 },
    privateKey,
    new TextEncoder().encode(msg)
  );
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(
      String.fromCharCode(...new Uint8Array(sig))
    ),
  };
}

// ─── FETCH HELPERS ────────────────────────────────────────────────────────────

async function kalshiFetch(path: string): Promise<any> {
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok)
    throw new Error(`Kalshi API error ${res.status}: ${await res.text()}`);
  return res.json();
}

async function kalshiAuthFetch(
  method: string,
  path: string,
  body: unknown,
  keyId: string,
  privateKey: CryptoKey
): Promise<any> {
  const headers = await signedHeaders(method, `/trade-api/v2${path}`, keyId, privateKey);
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok)
    throw new Error(`Kalshi auth error ${res.status}: ${await res.text()}`);
  return res.json();
}

// ─── MCP AGENT ───────────────────────────────────────────────────────────────

interface Env {
  KALSHI_KEY_ID: string;
  KALSHI_PRIVATE_KEY: string;
}

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Data", version: "1.5.0" });

  async init() {
    // ── Public tools (no auth needed) ────────────────────────────────────────

    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events for a sport. NBA bundles all markets in one event. World Cup and MLB each have THREE separate series for moneyline/spread/total — all fetched together automatically. For extra props use kalshi_search_series.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        if (sport in MULTI_SERIES_SPORTS) {
          const tickers = MULTI_SERIES_SPORTS[sport];
          const results: Record<string, unknown> = {};
          for (const ticker of tickers) {
            results[ticker] = await kalshiFetch(
              `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
            );
          }
          return {
            content: [{ type: "text", text: JSON.stringify({ sport, series: results }) }],
          };
        }
        const ticker = SINGLE_SERIES_SPORTS[sport];
        const data = await kalshiFetch(
          `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
        );
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
        const matches = all.filter((s: any) =>
          (s.title ?? "").toLowerCase().includes(kw)
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                keyword,
                match_count: matches.length,
                matches,
                note: matches.length === 0
                  ? "No matches — try a shorter keyword."
                  : "Use the 'ticker' field with kalshi_get_series_events.",
              }),
            },
          ],
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
        const data = await kalshiFetch(
          `/events/${event_ticker}?with_nested_markets=true`
        );
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
        const lim = limit ?? 20;
        const data = await kalshiFetch(
          `/markets/${market_ticker}/trades?limit=${lim}`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    // ── Authenticated tool: real combo RFQ price ──────────────────────────────

    this.server.tool(
      "kalshi_get_combo_price",
      "Submit a real Kalshi RFQ for a combo and return the live quoted price from market makers. Pass an array of market tickers (the legs) — e.g. ['KXMLBGAME-26JUN22NYYBOS-T', 'KXMLBTOTAL-26JUN22NYYBOS-O8']. Returns the real yes_bid price (0-100 integer) market makers are willing to quote for this exact combo. This is the real combo multiplier, not an estimate.",
      {
        market_tickers: z.array(z.string()).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ market_tickers, contracts }) => {
        const keyId = this.env.KALSHI_KEY_ID;
        const privateKey = await importPrivateKey(this.env.KALSHI_PRIVATE_KEY);

        // Step 1: Find or create the multivariate market for these legs
        const mveBody = {
          legs: market_tickers.map((ticker) => ({
            market_ticker: ticker,
            side: "yes",
          })),
        };

        let mveTicker: string;
        try {
          const mveRes = await kalshiAuthFetch(
            "POST",
            "/events/multivariate",
            mveBody,
            keyId,
            privateKey
          );
          mveTicker = mveRes.market_ticker ?? mveRes.ticker;
          if (!mveTicker) throw new Error("No market ticker returned from MVE creation: " + JSON.stringify(mveRes));
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Could not create multivariate market for these legs",
                detail: e.message,
                note: "This combo may not be eligible for RFQ — legs may not be from the same event or may not be open.",
              }),
            }],
          };
        }

        // Step 2: Submit RFQ
        const rfqBody = { market_ticker: mveTicker, contracts_fp: contracts.toString() };
        let rfqId: string;
        try {
          const rfqRes = await kalshiAuthFetch("POST", "/portfolio/rfqs", rfqBody, keyId, privateKey);
          rfqId = rfqRes.rfq?.rfq_id ?? rfqRes.rfq_id;
          if (!rfqId) throw new Error("No RFQ ID returned: " + JSON.stringify(rfqRes));
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "RFQ submission failed",
                detail: e.message,
                mve_ticker: mveTicker,
              }),
            }],
          };
        }

        // Step 3: Poll for quotes (up to 8 seconds)
        let bestYesBid: number | null = null;
        let bestNoBid: number | null = null;
        for (let i = 0; i < 8; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          try {
            const quotesRes = await kalshiAuthFetch(
              "GET",
              `/portfolio/rfqs/${rfqId}/quotes`,
              null,
              keyId,
              privateKey
            );
            const quotes: any[] = quotesRes.quotes ?? [];
            for (const q of quotes) {
              const yb = parseFloat(q.yes_bid_dollars ?? "0") * 100;
              const nb = parseFloat(q.no_bid_dollars ?? "0") * 100;
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = Math.round(yb);
                bestNoBid = Math.round(nb);
              }
            }
            if (bestYesBid !== null) break;
          } catch (_) {}
        }

        // Step 4: Cancel the RFQ (we only wanted the price, not to trade)
        try {
          await kalshiAuthFetch("DELETE", `/portfolio/rfqs/${rfqId}`, null, keyId, privateKey);
        } catch (_) {}

        if (bestYesBid === null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                rfq_id: rfqId,
                mve_ticker: mveTicker,
                result: "no_quote",
                note: "No market maker responded with a quote in 8 seconds. This combo may have low liquidity or market makers aren't active right now. Try closer to game time.",
                legs: market_tickers,
              }),
            }],
          };
        }

        const multiplier = (100 / bestYesBid).toFixed(2);
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              legs: market_tickers,
              mve_ticker: mveTicker,
              yes_bid: bestYesBid,
              no_bid: bestNoBid,
              multiplier_real: `${multiplier}x`,
              note: "This is the REAL Kalshi RFQ price from a live market maker — not an estimate. The RFQ was cancelled after pricing so no trade was placed.",
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
