import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const SPORT_TICKERS: Record<string, string> = {
  worldcup: "KXWCGAME",
  mlb: "KXMLBGAME",
  nba: "KXNBAGAME",
};

async function kalshiFetch(path: string) {
  const res = await fetch(`${KALSHI_BASE}${path}`, {
    headers: { Accept: "application/json" },
  });
  if (!res.ok) {
    throw new Error(`Kalshi API error ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

export class MyMCP extends McpAgent {
  server = new McpServer({
    name: "Kalshi Sports Data",
    version: "1.1.0",
  });

  async init() {
    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events (games) for a sport, including nested markets (moneyline, spread, total, props).",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        const ticker = SPORT_TICKERS[sport];
        const data = await kalshiFetch(
          `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Get all markets (moneyline, spread, total, player props) for one specific Kalshi game event.",
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
      "Get details for a single Kalshi market by its market ticker (price, volume, etc.).",
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

    this.server.tool(
      "kalshi_get_combo_collections",
      "List available Kalshi multivariate (combo/parlay) collections for a sport — shows which combo types exist and are tradeable for that sport.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        const ticker = SPORT_TICKERS[sport];
        const data = await kalshiFetch(
          `/multivariate_event_collections?series_ticker=${ticker}`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_markets",
      "Get REAL, market-priced combo (multivariate/parlay) odds for a sport — these are actual Kalshi-quoted combo prices, not estimates.",
      {
        sport: z.enum(["worldcup", "mlb", "nba"]),
        collection_ticker: z.string().optional(),
      },
      async ({ sport, collection_ticker }) => {
        const ticker = SPORT_TICKERS[sport];
        let path = `/events/multivariate?series_ticker=${ticker}&with_nested_markets=true`;
        if (collection_ticker) {
          path += `&collection_ticker=${collection_ticker}`;
        }
        const data = await kalshiFetch(path);
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
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
