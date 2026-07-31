import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const EXT  = "https://external-api.kalshi.com/trade-api/v2";
const ELEC = "https://api.elections.kalshi.com/trade-api/v2";

// Game-level series (used to discover today's events)
const MLB_GAME_SERIES  = ["KXMLBGAME","KXMLBSPREAD","KXMLBTOTAL","KXMLBF5TOTAL"];
const NBA_GAME_SERIES  = ["KXNBAGAME","KXNBASPREAD","KXNBATOTAL",
                          "KXNBASUMMERGAME","KXNBASUMMERSPREAD","KXNBASUMMERTOTAL"];

// ── Auth ──────────────────────────────────────────────────────────────────────

async function importKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try { decoded = atob(pem.trim()); }
  catch { throw new Error(`PEM not valid base64. Starts: "${pem.slice(0,40)}"`); }
  const body = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g,"")
    .replace(/-----END [A-Z ]+-----/g,"")
    .replace(/\s+/g,"");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body))
    throw new Error(`Key body malformed. Starts: "${body.slice(0,30)}"`);
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name:"RSA-PSS", hash:"SHA-256" }, false, ["sign"]
  );
}

async function sign(
  method: string, path: string, kid: string, pk: CryptoKey, hasBody = false
): Promise<Record<string,string>> {
  const ts = Date.now().toString();
  const pathOnly = `/trade-api/v2${path}`.split("?")[0];
  const sig = await crypto.subtle.sign(
    { name:"RSA-PSS", saltLength:32 }, pk,
    new TextEncoder().encode(ts + method.toUpperCase() + pathOnly)
  );
  const h: Record<string,string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": kid,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

async function pub(path: string): Promise<any> {
  const r = await fetch(`${EXT}${path}`, { headers:{ Accept:"application/json" } });
  if (!r.ok) {
    const text = await r.text();
    if (r.status === 429) throw new Error(`RATE_LIMITED`);
    throw new Error(`${r.status}: ${text}`);
  }
  return r.json();
}

async function aGET(path: string, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("GET", path, kid, pk, false);
  const r = await fetch(`${ELEC}${path}`, { method:"GET", headers:h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function aPOST_ext(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("POST", path, kid, pk, true);
  const r = await fetch(`${EXT}${path}`, { method:"POST", headers:h, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function aDEL_ext(path: string, kid: string, pk: CryptoKey): Promise<void> {
  const h = await sign("DELETE", path, kid, pk, false);
  await fetch(`${EXT}${path}`, { method:"DELETE", headers:h });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCents(s: string|undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  if (isNaN(v) || v === 0) return 0;
  return Math.round(v < 1.01 ? v * 100 : v);
}

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// Step 1: get event tickers for a list of series (game-level only, fast)
async function getEventTickers(seriesList: string[]): Promise<string[]> {
  const tickers = new Set<string>();
  for (const series of seriesList) {
    try {
      const d = await pub(`/events?series_ticker=${series}&status=open&limit=50`);
      for (const ev of d.events ?? []) {
        if (ev.event_ticker) tickers.add(ev.event_ticker);
      }
      await delay(200);
    } catch (e: any) {
      if (e.message === "RATE_LIMITED") throw e;
      // skip series on other errors
    }
  }
  return [...tickers];
}

// Step 2: get ALL markets for a specific event (includes props)
async function getEventMarkets(eventTicker: string): Promise<any[]> {
  const markets: any[] = [];
  try {
    // Use /markets endpoint filtered by event_ticker — gets game + all props
    const d = await pub(`/markets?event_ticker=${eventTicker}&status=active&limit=200`);
    for (const m of d.markets ?? []) {
      const yb = toCents(m.yes_bid_dollars);
      const ya = toCents(m.yes_ask_dollars);
      const nb = toCents(m.no_bid_dollars);
      if (yb === 0 && ya === 0 && nb === 0) continue;
      markets.push({
        s: m.series_ticker ?? "",
        et: m.event_ticker ?? eventTicker,
        mt: m.ticker,
        t: (m.yes_sub_title ?? m.title ?? "").slice(0,70),
        yb, ya, nb,
        vol: Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
      });
    }
  } catch (e: any) {
    if (e.message === "RATE_LIMITED") throw e;
  }
  return markets;
}

// Main fetch — 2 API calls per game instead of 20+ series calls
async function fetchSport(seriesList: string[]): Promise<Record<string, any[]>> {
  const byGame: Record<string, any[]> = {};

  // Step 1: discover event tickers (N series calls, N = 2-6)
  const eventTickers = await getEventTickers(seriesList);

  // Step 2: fetch all markets per event (1 call per game)
  for (const et of eventTickers) {
    const markets = await getEventMarkets(et);
    if (markets.length > 0) byGame[et] = markets;
    await delay(250); // respectful pace — 4 calls/second max
  }

  return byGame;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name:"Kalshi Sports Connector", version:"6.0.0" });

  async init() {

    // PRIMARY TOOL
    this.server.tool(
      "kalshi_get_all_today",
      "PRIMARY TOOL. Fetches ALL active Kalshi markets for MLB and NBA — game markets (moneyline, spread, total, F5 total) AND player props (HR, strikeouts, hits, HRR, total bases, outs recorded, RBI, stolen bases for MLB; points, rebounds, assists, 3PT for NBA). Uses smart 2-step fetch to avoid rate limits. Returns markets grouped by sport and game event_ticker. Fields: mt=market_ticker, et=event_ticker, s=series, t=title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Multiplier = 100/yb.",
      {},
      async () => {
        try {
          const [mlbGames, nbaGames] = await Promise.allSettled([
            fetchSport(MLB_GAME_SERIES),
            fetchSport(NBA_GAME_SERIES),
          ]);

          const mlb = mlbGames.status === "fulfilled" ? mlbGames.value : {};
          const nba = nbaGames.status === "fulfilled" ? nbaGames.value : {};

          const out: Record<string,any> = {};

          if (Object.keys(mlb).length > 0) {
            out.mlb = {
              game_count: Object.keys(mlb).length,
              market_count: Object.values(mlb).flat().length,
              games: mlb,
            };
          }

          if (Object.keys(nba).length > 0) {
            out.nba = {
              game_count: Object.keys(nba).length,
              market_count: Object.values(nba).flat().length,
              games: nba,
            };
          }

          if (Object.keys(out).length === 0) {
            return { content:[{ type:"text", text:JSON.stringify({
              result: "no_markets",
              note: "No active MLB or NBA markets found. Either no games today or markets haven't opened yet.",
            }) }] };
          }

          return { content:[{ type:"text", text:JSON.stringify(out) }] };

        } catch (e: any) {
          if (e.message === "RATE_LIMITED") {
            return { content:[{ type:"text", text:JSON.stringify({
              result: "rate_limited",
              note: "Kalshi API rate limit hit. Wait 30 minutes before trying again. Do not make any more tool calls this session.",
            }) }] };
          }
          throw e;
        }
      }
    );

    // SINGLE SPORT
    this.server.tool(
      "kalshi_get_today_markets",
      "Fetch all active markets for MLB or NBA only. Use kalshi_get_all_today for both sports at once.",
      { sport: z.enum(["mlb","nba"]) },
      async ({ sport }) => {
        try {
          const series = sport === "mlb" ? MLB_GAME_SERIES : NBA_GAME_SERIES;
          const games = await fetchSport(series);
          return { content:[{ type:"text", text:JSON.stringify({
            sport,
            game_count: Object.keys(games).length,
            market_count: Object.values(games).flat().length,
            games,
          }) }] };
        } catch (e: any) {
          if (e.message === "RATE_LIMITED") {
            return { content:[{ type:"text", text:JSON.stringify({
              result:"rate_limited",
              note:"Kalshi API rate limited. Wait 30 minutes.",
            }) }] };
          }
          throw e;
        }
      }
    );

    // SINGLE GAME
    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific game by event_ticker. Includes all props for that game.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const markets = await getEventMarkets(event_ticker);
        return { content:[{ type:"text", text:JSON.stringify({
          event_ticker,
          market_count: markets.length,
          markets,
        }) }] };
      }
    );

    // SERIES LOOKUP
    this.server.tool(
      "kalshi_get_series_events",
      "Get all events and markets under any Kalshi series ticker (e.g. KXMLBHR, KXMLBKS).",
      { series_ticker: z.string() },
      async ({ series_ticker }) => {
        const d = await pub(`/events?series_ticker=${series_ticker}&with_nested_markets=true`);
        const markets: any[] = [];
        for (const ev of d.events ?? []) {
          for (const m of ev.markets ?? []) {
            if (m.status !== "active") continue;
            markets.push({
              mt:m.ticker, et:ev.event_ticker,
              t:(m.yes_sub_title ?? m.title ?? "").slice(0,70),
              yb:toCents(m.yes_bid_dollars),
              ya:toCents(m.yes_ask_dollars),
              nb:toCents(m.no_bid_dollars),
              vol:Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
            });
          }
        }
        return { content:[{ type:"text", text:JSON.stringify({
          series_ticker, market_count:markets.length, markets
        }) }] };
      }
    );

    // SERIES SEARCH
    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi sports series by keyword to find any prop or market type.",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await pub(`/series?category=Sports&limit=1000`);
        const kw = keyword.toLowerCase();
        const hits = ((data as any).series ?? [])
          .filter((s: any) =>
            (s.title ?? "").toLowerCase().includes(kw) ||
            (s.ticker ?? "").toLowerCase().includes(kw)
          )
          .slice(0,20)
          .map((s: any) => ({ ticker:s.ticker, title:s.title }));
        return { content:[{ type:"text", text:JSON.stringify({ keyword, results:hits }) }] };
      }
    );

    // COMBO COLLECTIONS
    this.server.tool(
      "kalshi_get_combo_collections",
      "Find combo collection tickers for a game. Default: KXMVESPORTSMULTIGAMEEXTENDED-R.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await pub(`/multivariate_event_collections?event_ticker=${event_ticker}&status=open`);
        const cols = (data as any).multivariate_contracts ?? [];
        return { content:[{ type:"text", text:JSON.stringify({
          collections:cols.map((c: any) => ({ collection_ticker:c.collection_ticker, title:c.title })),
          fallback:"KXMVESPORTSMULTIGAMEEXTENDED-R",
        }) }] };
      }
    );

    // COMBO PRICE
    this.server.tool(
      "kalshi_get_combo_price",
      "Gets combo multiplier from live leg prices. Submits RFQ for real market-maker quote when active. Pass yb from board data for each leg. RFQ cancelled after — no trade placed.",
      {
        collection_ticker: z.string().default("KXMVESPORTSMULTIGAMEEXTENDED-R"),
        legs: z.array(z.object({
          market_ticker: z.string(),
          event_ticker: z.string(),
          side: z.enum(["yes","no"]).default("yes"),
          yb: z.number().int().min(1).max(99),
        })).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ collection_ticker, legs, contracts }) => {
        const prices = legs.map(l => l.side === "no" ? 100 - l.yb : l.yb);
        const estMult = prices.reduce((a,p) => a*(100/p), 1).toFixed(2);
        const base = {
          legs: legs.map(l => ({ mt:l.market_ticker, side:l.side, yb:l.yb })),
          prices,
          estimated_multiplier: `${estMult}x`,
          real_multiplier: null as string|null,
        };

        let kid: string, pk: CryptoKey;
        try {
          kid = this.env.KALSHI_KEY_ID;
          pk = await importKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", note:`Auth: ${e.message}`
          }) }] };
        }

        // MVE
        let mveTicker: string;
        try {
          const path = `/multivariate_event_collections/${collection_ticker}`;
          const h = await sign("POST", path, kid, pk, true);
          const r = await fetch(`${ELEC}${path}`, {
            method:"POST", headers:h,
            body:JSON.stringify({
              selected_markets:legs.map(l => ({
                market_ticker:l.market_ticker,
                event_ticker:l.event_ticker,
                side:l.side,
              })),
              with_market_payload:true,
            }),
          });
          const b = await r.json() as any;
          if (r.status === 409) {
            mveTicker = b.market_ticker ?? b.ticker ?? b.data?.market_ticker;
            if (!mveTicker) throw new Error("409 no ticker");
          } else if (r.ok) {
            mveTicker = b.market_ticker ?? b.ticker;
            if (!mveTicker) throw new Error("No ticker");
          } else {
            throw new Error(`${r.status}: ${JSON.stringify(b)}`);
          }
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", note:`MVE: ${e.message}`
          }) }] };
        }

        // RFQ
        let rfqId: string;
        try {
          const res = await aPOST_ext(
            "/communications/rfqs",
            { market_ticker:mveTicker, contracts_fp:String(contracts) },
            kid, pk
          );
          rfqId = res.id ?? res.rfq?.rfq_id ?? res.rfq_id;
          if (!rfqId) throw new Error("No ID: " + JSON.stringify(res));
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", mve:mveTicker, note:`RFQ: ${e.message}`
          }) }] };
        }

        // Poll quotes
        let bestBid: number|null = null;
        let bestNoBid: number|null = null;
        for (let i = 0; i < 10; i++) {
          await delay(1000);
          try {
            const qr = await aGET(
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              kid, pk
            );
            for (const q of (qr.quotes ?? qr.data ?? [])) {
              const raw = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = raw < 1.01 ? Math.round(raw*100) : Math.round(raw);
              if (yb > 0 && (bestBid === null || yb > bestBid)) {
                bestBid = yb;
                const nr = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nr < 1.01 ? Math.round(nr*100) : Math.round(nr);
              }
            }
            if (bestBid !== null) break;
          } catch (_) {}
        }

        try { await aDEL_ext(`/communications/rfqs/${rfqId}`, kid, pk); } catch (_) {}

        if (bestBid !== null) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"success",
            real_multiplier:`${(100/bestBid).toFixed(2)}x`,
            real_yes_bid:bestBid, real_no_bid:bestNoBid,
            mve:mveTicker, note:"Real RFQ price. No trade placed.",
          }) }] };
        }

        return { content:[{ type:"text", text:JSON.stringify({
          ...base, result:"estimate_only", mve:mveTicker,
          note:"No market maker response — estimated multiplier from live prices.",
        }) }] };
      }
    );

    // BASKETBALL DISCOVERY
    this.server.tool(
      "kalshi_find_basketball_series",
      "Discovers all active NBA/Summer League series on Kalshi with open events.",
      {},
      async () => {
        const data = await pub(`/series?category=Sports&limit=1000`);
        const all = (data as any).series ?? [];
        const bball = all
          .filter((s: any) => (s.ticker ?? "").toUpperCase().startsWith("KXNBA"))
          .map((s: any) => ({ ticker:s.ticker, title:s.title }));

        const active: any[] = [], inactive: any[] = [];
        for (const s of bball) {
          try {
            const ev = await pub(`/events?series_ticker=${s.ticker}&limit=1`);
            if ((ev.events ?? []).length > 0) active.push(s);
            else inactive.push(s);
          } catch (_) { inactive.push(s); }
          await delay(200);
        }
        return { content:[{ type:"text", text:JSON.stringify({
          active_series_with_open_events:active,
          inactive_series:inactive,
        }) }] };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message")
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    if (url.pathname === "/mcp")
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    return new Response("Kalshi Sports Connector v6.0", { status:200 });
  },
};
