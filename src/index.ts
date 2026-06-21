import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const SPORT_TICKERS: Record<string, string> = {
  mlb: "KXMLBGAME",
  nba: "KXNBAGAME",
};
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
    version: "1.3.0",
  });

  async init() {
    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi's full list of Sports series by keyword to discover ticker codes for prop markets (corners, anytime goalscorer, BTTS, player points/rebounds/assists, home runs, etc.) that aren't covered by the main game tools. Example keywords: 'World Cup corner', 'World Cup goalscorer', 'NBA points', 'MLB home run'.",
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
                matches,
                note: matches.length === 0
                  ? "No matches — try a shorter or different keyword (e.g. just 'corner' or 'goalscorer')."
                  : "Use the 'ticker' field with kalshi_get_series_events to pull live data for any of these.",
              }),
            },
          ],
        };
      }
    );

    this.server.tool(
      "kalshi_get_series_events",
      "Get today's open events/markets for ANY Kalshi series ticker, including prop series found via kalshi_search_series (corners, goalscorers, player props, etc.).",
      { series_ticker: z.string() },
      async ({ series_ticker }) => {
        const data = await kalshiFetch(
          `/events?series_ticker=${series_ticker}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events for a sport's MAIN markets. NBA/MLB: moneyline/spread/total/props bundled in one event. World Cup: only moneyline/spread/total — use kalshi_search_series + kalshi_get_series_events for World Cup props like corners or goalscorers.",
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
                  note: "These 3 series cover moneyline/spread/total only. For World Cup props (corners, goalscorers, BTTS), use kalshi_search_series first.",
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
      "kalshi_get_combo_markets",
      "Get REAL, market-priced combo (multivariate/parlay) odds for any series ticker — actual Kalshi-quoted combo prices, not estimates.",
      { series_ticker: z.string() },
      async ({ series_ticker }) => {
        const data = await kalshiFetch(
          `/events/multivariate?series_ticker=${series_ticker}&with_nested_markets=true`
        );
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
