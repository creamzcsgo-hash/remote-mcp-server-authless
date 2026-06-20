import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// NBA and MLB bundle moneyline/spread/total/props into one event.
const SPORT_TICKERS: Record<string, string> = {
  mlb: "KXMLBGAME",
  nba: "KXNBAGAME",
};

// World Cup splits moneyline/spread/total into THREE separate series.
const WORLDCUP_TICKERS = ["KXWCGAME", "KXWCSPREAD", "KXWCTOTAL"];

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
    version: "1.2.0",
  });

  async init() {
    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events (games) for a sport. For NBA/MLB this includes nested moneyline/spread/total/props in one event. For World Cup, it returns THREE separate series (game winner, spread, total) — match legs across them by date+teams in the event ticker to find legs from the same match.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        if (sport === "worldcup") {
          const results: Record<string, unknown> = {};
          for (const ticker of WORLDCUP_TICKERS) {
            results[ticker] = await kalshiFetch(
              `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
            );
          }
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  note: "World Cup has 3 separate series: KXWCGAME (moneyline), KXWCSPREAD (spread), KXWCTOTAL (total goals). Match legs across them using the date+teams portion of each event ticker to find legs belonging to the same match.",
                  series: results,
                }),
              },
            ],
          };
        }
        const ticker = SPORT_TICKERS[sport];
        const data = await kalshiFetch(
          `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific Kalshi event (one series only — for World Cup you may need to call this once per series: KXWCGAME/KXWCSPREAD/KXWCTOTAL event tickers for the same match).",
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
      "List available Kalshi multivariate (combo/parlay) collections for a sport — shows what's tradeable as a real combo.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        if (sport === "worldcup") {
          const results: Record<string, unknown> = {};
          for (const ticker of WORLDCUP_TICKERS) {
            results[ticker] = await kalshiFetch(
              `/multivariate_event_collections?series_ticker=${ticker}`
            );
          }
          return { content: [{ type: "text", text: JSON.stringify(results) }] };
        }
        const ticker = SPORT_TICKERS[sport];
        const data = await kalshiFetch(
          `/multivariate_event_collections?series_ticker=${ticker}`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_markets",
      "Get REAL, market-priced combo (multivariate/parlay) odds for a sport — actual Kalshi-quoted combo prices, not estimates.",
      {
        sport: z.enum(["worldcup", "mlb", "nba"]),
        collection_ticker: z.string().optional(),
      },
      async ({ sport, collection_ticker }) => {
        if (sport === "worldcup") {
          const results: Record<string, unknown> = {};
          for (const ticker of WORLDCUP_TICKERS) {
            let path = `/events/multivariate?series_ticker=${ticker}&with_nested_markets=true`;
            if (collection_ticker) path += `&collection_ticker=${collection_ticker}`;
            results[ticker] = await kalshiFetch(path);
          }
          return { content: [{ type: "text", text: JSON.stringify(results) }] };
        }
        const ticker = SPORT_TICKERS[sport];
        let path = `/events/multivariate?series_ticker=${ticker}&with_nested_markets=true`;
        if (collection_ticker) path += `&collection_ticker=${collection_ticker}`;
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
