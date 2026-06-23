import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

// These sports have spread/total in SEPARATE series (like World Cup)
const MULTI_SERIES_SPORTS: Record<string, string[]> = {
  worldcup: ["KXWCGAME", "KXWCSPREAD", "KXWCTOTAL"],
  mlb: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
};

// NBA bundles moneyline/spread/total/props in one event
const SINGLE_SERIES_SPORTS: Record<string, string> = {
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
    version: "1.4.0",
  });

  async init() {
    this.server.tool(
      "kalshi_list_events",
      "Get today's open Kalshi events for a sport. NBA bundles all markets in one event. World Cup and MLB each have THREE separate series for moneyline/spread/total — all fetched together automatically. For props beyond these (corners, goalscorers, player HR/strikeouts etc.) use kalshi_search_series.",
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
          const labels: Record<string, Record<string, string>> = {
            worldcup: {
              KXWCGAME: "moneyline (Win/Win/Tie)",
              KXWCSPREAD: "spread (win by X goals)",
              KXWCTOTAL: "total goals (over/under)",
            },
            mlb: {
              KXMLBGAME: "moneyline (game winner)",
              KXMLBSPREAD: "run line (spread)",
              KXMLBTOTAL: "total runs (over/under)",
            },
          };
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  note: `${sport.toUpperCase()} uses 3 separate series. Match legs across them using the date+teams in each event ticker to find same-game legs.`,
                  series_labels: labels[sport],
                  series: results,
                }),
              },
            ],
          };
        }
        // Single-series sport (NBA)
        const ticker = SINGLE_SERIES_SPORTS[sport];
        const data = await kalshiFetch(
          `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
        );
        return { content: [{ type: "text", text: JSON.stringify(data) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi's full Sports series list by keyword to find prop series tickers (corners, anytime goalscorer, BTTS, player HR, strikeouts, points, rebounds, assists, etc.). Examples: 'World Cup corner', 'World Cup goalscorer', 'MLB home run', 'MLB strikeout', 'NBA points', 'NBA rebounds'.",
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
                note:
                  matches.length === 0
                    ? "No matches — try a shorter keyword (e.g. just 'corner' or 'home run')."
                    : "Use the 'ticker' field with kalshi_get_series_events to pull live prices.",
              }),
            },
          ],
        };
      }
    );

    this.server.tool(
      "kalshi_get_series_events",
      "Get today's open events/markets for ANY Kalshi series ticker — use this with tickers found via kalshi_search_series to pull live prop prices.",
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
      "Get price and volume details for a single Kalshi market by its market ticker.",
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
