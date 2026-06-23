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

// ─── AUTH HELPERS ─────────────────────────────────────────────────────────────

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // pem is now stored as a base64-encoded PEM to avoid Cloudflare
  // stripping spaces from header lines — decode it first
  let decoded: string;
  try {
    decoded = atob(pem.trim());
  } catch (e) {
    throw new Error(
      `KALSHI_PRIVATE_KEY does not appear to be base64-encoded. ` +
      `Re-encode your PEM file using PowerShell and re-paste into Cloudflare. ` +
      `Raw value starts with: "${pem.substring(0, 40)}"`
    );
  }

  // Now extract the key body from the decoded PEM
  const pemContent = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");

  if (!/^[A-Za-z0-9+/]+=*$/.test(pemContent)) {
    throw new Error(
      `Key body is malformed after decoding. ` +
      `Starts with: "${pemContent.substring(0, 30)}"`
    );
  }

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
  const headers = await signedHeaders(
    method,
    `/trade-api/v2${path}`,
    keyId,
    privateKey
  );
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
  server = new McpServer({ name: "Kalshi Sports Data", version: "1.6.0" });

  async init() {

    // ── PUBLIC TOOLS ─────────────────────────────────────────────────────────

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
            content: [{
              type: "text",
              text: JSON.stringify({ sport, series: results }),
            }],
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
          content: [{
            type: "text",
            text: JSON.stringify({
              keyword,
              match_count: matches.length,
              matches,
              note: matches.length === 0
                ? "No matches — try a shorter keyword."
                : "Use the 'ticker' field with kalshi_get_series_events.",
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

    // ── AUTHENTICATED TOOL: real combo RFQ price ──────────────────────────────

    this.server.tool(
      "kalshi_get_combo_price",
      "Submit a real Kalshi RFQ for a combo and return the live quoted price from market makers. Pass the exact market tickers for each leg (2-4 legs). Returns the real multiplier from a live market maker quote. The RFQ is automatically cancelled after pricing so no trade is placed.",
      {
        market_tickers: z.array(z.string()).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ market_tickers, contracts }) => {
        // Load credentials
        const keyId = this.env.KALSHI_KEY_ID;
        let privateKey: CryptoKey;
        try {
          privateKey = await importPrivateKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Private key import failed",
                detail: e.message,
                fix: "The KALSHI_PRIVATE_KEY secret in Cloudflare may be malformed. Re-paste the full PEM including the BEGIN/END lines.",
              }),
            }],
          };
        }

        // Step 1: Create the multivariate (combo) market for these legs
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
          if (!mveTicker)
            throw new Error(
              "No market ticker in response: " + JSON.stringify(mveRes)
            );
        } catch (e: any) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                error: "Could not create combo market for these legs",
                detail: e.message,
                legs: market_tickers,
                note: "Legs may not be from the same eligible event, or one of the markets may be closed.",
              }),
            }],
          };
        }

        // Step 2: Submit the RFQ
        let rfqId: string;
        try {
          const rfqRes = await kalshiAuthFetch(
            "POST",
            "/portfolio/rfqs",
            { market_ticker: mveTicker, contracts_fp: contracts.toString() },
            keyId,
            privateKey
          );
          rfqId = rfqRes.rfq?.rfq_id ?? rfqRes.rfq_id;
          if (!rfqId)
            throw new Error("No RFQ ID in response: " + JSON.stringify(rfqRes));
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
              const yb = Math.round(
                parseFloat(q.yes_bid_dollars ?? "0") * 100
              );
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = yb;
                bestNoBid = Math.round(
                  parseFloat(q.no_bid_dollars ?? "0") * 100
                );
              }
            }
            if (bestYesBid !== null) break;
          } catch (_) {}
        }

        // Step 4: Cancel the RFQ — we only wanted the price
        try {
          await kalshiAuthFetch(
            "DELETE",
            `/portfolio/rfqs/${rfqId}`,
            null,
            keyId,
            privateKey
          );
        } catch (_) {}

        // Step 5: Return result
        if (bestYesBid === null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: "no_quote",
                rfq_id: rfqId,
                mve_ticker: mveTicker,
                legs: market_tickers,
                note: "No market maker responded within 8 seconds. This combo may have low liquidity right now. Try again closer to game time.",
              }),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              result: "success",
              legs: market_tickers,
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

// ─── ENTRY POINT ─────────────────────────────────────────────────────────────

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
