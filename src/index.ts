import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://external-api.kalshi.com/trade-api/v2";
const KALSHI_AUTH_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const SERIES: Record<string, string[]> = {
  worldcup: [
    "KXWCGAME","KXWCSPREAD","KXWCTOTAL","KXWCSCORE",
    "KXWCBTTS","KXWCTT","KXWC1H","KXWC1HSPREAD",
    "KXWC1HTOTAL","KXWC1HBTTS","KXWCGOAL","KXWCCORNERS","KXWCADVANCE",
  ],
  mlb: ["KXMLBGAME","KXMLBSPREAD","KXMLBTOTAL"],
  nba: ["KXNBAGAME"],
};

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try { decoded = atob(pem.trim()); }
  catch { throw new Error(`PEM not valid base64. Starts: "${pem.substring(0,40)}"`); }
  const body = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g,"")
    .replace(/-----END [A-Z ]+-----/g,"")
    .replace(/\s+/g,"");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body))
    throw new Error(`Key body malformed. Starts: "${body.substring(0,30)}"`);
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name:"RSA-PSS", hash:"SHA-256" }, false, ["sign"]
  );
}

async function makeHeaders(
  method: string, path: string, keyId: string, pk: CryptoKey, hasBody = false
): Promise<Record<string,string>> {
  const ts = Date.now().toString();
  const pathOnly = path.split("?")[0];
  const sig = await crypto.subtle.sign(
    { name:"RSA-PSS", saltLength:32 }, pk,
    new TextEncoder().encode(ts + method.toUpperCase() + pathOnly)
  );
  const h: Record<string,string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

function toInt(s: string|undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  return Math.round(v <= 1 ? v * 100 : v);
}

async function pubFetch(path: string): Promise<any> {
  const r = await fetch(`${KALSHI_BASE}${path}`, { headers:{ Accept:"application/json" } });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authGet(path: string, kid: string, pk: CryptoKey): Promise<any> {
  const h = await makeHeaders("GET", `/trade-api/v2${path}`, kid, pk, false);
  const r = await fetch(`${KALSHI_AUTH_BASE}${path}`, { method:"GET", headers:h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authPost(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await makeHeaders("POST", `/trade-api/v2${path}`, kid, pk, true);
  const r = await fetch(`${KALSHI_AUTH_BASE}${path}`, { method:"POST", headers:h, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authDelete(path: string, kid: string, pk: CryptoKey): Promise<void> {
  const h = await makeHeaders("DELETE", `/trade-api/v2${path}`, kid, pk, false);
  await fetch(`${KALSHI_AUTH_BASE}${path}`, { method:"DELETE", headers:h });
}

function extractMarkets(events: any[], series: string): any[] {
  const rows: any[] = [];
  for (const ev of events ?? []) {
    for (const m of ev.markets ?? []) {
      if (m.status !== "active") continue;
      const yb = toInt(m.yes_bid_dollars);
      const ya = toInt(m.yes_ask_dollars);
      const nb = toInt(m.no_bid_dollars);
      if (yb === 0 && ya === 0) continue;
      rows.push({
        s: series,
        et: ev.event_ticker,
        mt: m.ticker,
        t: (m.yes_sub_title ?? m.title ?? "").substring(0,60),
        yb, ya, nb,
        vol: m.volume_fp ?? m.volume ?? 0,
      });
    }
  }
  return rows;
}

async function fetchSeries(ticker: string): Promise<any[]> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const d = await pubFetch(
        `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
      );
      return extractMarkets(d.events ?? [], ticker);
    } catch (e: any) {
      if (e.message.startsWith("429") && attempt < 2) {
        await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      return [];
    }
  }
  return [];
}

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name:"Kalshi Sports Data", version:"2.4.0" });

  async init() {

    this.server.tool(
      "kalshi_get_all_today",
      "PRIMARY TOOL. Returns all open active Kalshi markets for World Cup + MLB + NBA grouped by game. Fields: s=series, et=event_ticker, mt=market_ticker, t=title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Multiplier per leg = 100/yb.",
      {},
      async () => {
        const result: Record<string,any> = {};
        for (const sport of ["worldcup","mlb","nba"] as const) {
          const byEvent: Record<string,any[]> = {};
          for (const ticker of SERIES[sport]) {
            const rows = await fetchSeries(ticker);
            for (const row of rows) {
              if (!byEvent[row.et]) byEvent[row.et] = [];
              byEvent[row.et].push(row);
            }
            await new Promise(r => setTimeout(r, 150));
          }
          result[sport] = {
            games: byEvent,
            game_count: Object.keys(byEvent).length,
            market_count: Object.values(byEvent).flat().length,
          };
        }
        return { content:[{ type:"text", text:JSON.stringify(result) }] };
      }
    );

    this.server.tool(
      "kalshi_get_today_markets",
      "Returns all open active markets for one sport only. Use kalshi_get_all_today for the full daily briefing.",
      { sport: z.enum(["worldcup","mlb","nba"]) },
      async ({ sport }) => {
        const byEvent: Record<string,any[]> = {};
        for (const ticker of SERIES[sport]) {
          const rows = await fetchSeries(ticker);
          for (const row of rows) {
            if (!byEvent[row.et]) byEvent[row.et] = [];
            byEvent[row.et].push(row);
          }
          await new Promise(r => setTimeout(r, 150));
        }
        return {
          content:[{ type:"text", text:JSON.stringify({
            sport, games:byEvent,
            game_count: Object.keys(byEvent).length,
            market_count: Object.values(byEvent).flat().length,
          }) }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific game event ticker.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await pubFetch(`/events/${event_ticker}?with_nested_markets=true`);
        const markets = extractMarkets([data.event ?? data], event_ticker);
        return { content:[{ type:"text", text:JSON.stringify({ event_ticker, markets }) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Search for any Kalshi sports series ticker by keyword (corners, goalscorer, props etc).",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await pubFetch(`/series?category=Sports&limit=1000`);
        const kw = keyword.toLowerCase();
        const matches = ((data as any).series ?? [])
          .filter((s: any) =>
            (s.title ?? "").toLowerCase().includes(kw) ||
            (s.ticker ?? "").toLowerCase().includes(kw)
          )
          .slice(0,20)
          .map((s: any) => ({ ticker:s.ticker, title:s.title }));
        return { content:[{ type:"text", text:JSON.stringify({ keyword, matches }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_collections",
      "Find combo collection tickers for a game event. Default fallback: KXMVESPORTSMULTIGAMEEXTENDED-R.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await pubFetch(
          `/multivariate_event_collections?event_ticker=${event_ticker}&status=open`
        );
        const cols = (data as any).multivariate_contracts ?? [];
        return {
          content:[{ type:"text", text:JSON.stringify({
            collections: cols.map((c: any) => ({ collection_ticker:c.collection_ticker, title:c.title })),
            fallback: "KXMVESPORTSMULTIGAMEEXTENDED-R",
          }) }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_combo_price",
      "Gets the combo multiplier for a set of legs. Always returns estimated_multiplier instantly from the yb prices you pass in. Also attempts a live RFQ for a real market-maker quote — real_multiplier is populated if one responds. Pass yb from board data for each leg. RFQ is cancelled after — no trade placed.",
      {
        collection_ticker: z.string().default("KXMVESPORTSMULTIGAMEEXTENDED-R"),
        selected_markets: z.array(z.object({
          market_ticker: z.string(),
          event_ticker: z.string(),
          side: z.enum(["yes","no"]).default("yes"),
          yb: z.number().int().min(1).max(99),
        })).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ collection_ticker, selected_markets, contracts }) => {

        // Estimated multiplier — always available immediately
        const legPrices = selected_markets.map(leg =>
          leg.side === "no" ? (100 - leg.yb) : leg.yb
        );
        const estMultiplier = legPrices
          .reduce((acc, p) => acc * (100 / Math.max(p, 1)), 1)
          .toFixed(2);

        const baseResult = {
          legs: selected_markets.map(m => ({ mt:m.market_ticker, side:m.side, yb:m.yb })),
          leg_prices: legPrices,
          estimated_multiplier: `${estMultiplier}x`,
          real_multiplier: null as string|null,
        };

        // Attempt live RFQ
        let kid: string;
        let pk: CryptoKey;
        try {
          kid = this.env.KALSHI_KEY_ID;
          pk = await importPrivateKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...baseResult, result:"estimate_only",
            note:`Auth failed: ${e.message}`,
          }) }] };
        }

        // MVE creation
        let mveTicker: string;
        try {
          const mveH = await makeHeaders(
            "POST",
            `/trade-api/v2/multivariate_event_collections/${collection_ticker}`,
            kid, pk, true
          );
          const mveRes = await fetch(
            `${KALSHI_AUTH_BASE}/multivariate_event_collections/${collection_ticker}`,
            {
              method:"POST", headers:mveH,
              body:JSON.stringify({
                selected_markets: selected_markets.map(m => ({
                  market_ticker: m.market_ticker,
                  event_ticker: m.event_ticker,
                  side: m.side,
                })),
                with_market_payload: true,
              }),
            }
          );
          const mveBody = await mveRes.json() as any;
          if (mveRes.status === 409) {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker ?? mveBody.data?.market_ticker;
          } else if (mveRes.ok) {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker;
          } else {
            throw new Error(`${mveRes.status}: ${JSON.stringify(mveBody)}`);
          }
          if (!mveTicker!) throw new Error("No MVE ticker in response");
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...baseResult, result:"estimate_only",
            note:`MVE failed: ${e.message}`,
          }) }] };
        }

        // RFQ submission
        let rfqId: string;
        try {
          const rfqRes = await authPost(
            "/communications/rfqs",
            { market_ticker:mveTicker, contracts_fp:contracts.toString() },
            kid, pk
          );
          rfqId = rfqRes.id ?? rfqRes.rfq?.rfq_id ?? rfqRes.rfq_id;
          if (!rfqId) throw new Error("No RFQ ID in: " + JSON.stringify(rfqRes));
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...baseResult, result:"estimate_only",
            mve: mveTicker,
            note:`RFQ submit failed: ${e.message}`,
          }) }] };
        }

        // Poll for quotes (10 seconds, path-only signing on GET)
        let bestYesBid: number|null = null;
        let bestNoBid: number|null = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const qRes = await authGet(
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              kid, pk
            );
            for (const q of (qRes.quotes ?? qRes.data ?? [])) {
              const ybRaw = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = ybRaw <= 1 ? Math.round(ybRaw * 100) : Math.round(ybRaw);
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = yb;
                const nbRaw = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nbRaw <= 1 ? Math.round(nbRaw * 100) : Math.round(nbRaw);
              }
            }
            if (bestYesBid !== null) break;
          } catch (_) {}
        }

        // Cancel RFQ
        try { await authDelete(`/communications/rfqs/${rfqId}`, kid, pk); } catch (_) {}

        if (bestYesBid !== null) {
          baseResult.real_multiplier = `${(100 / bestYesBid).toFixed(2)}x`;
        }

        return { content:[{ type:"text", text:JSON.stringify({
          ...baseResult,
          result: bestYesBid !== null ? "success" : "estimate_only",
          yes_bid: bestYesBid,
          no_bid: bestNoBid,
          mve: mveTicker,
          note: bestYesBid !== null
            ? "Real RFQ price from live market maker. No trade placed."
            : "No market maker active — estimated multiplier from live leg prices.",
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
    return new Response("Not found", { status:404 });
  },
};
