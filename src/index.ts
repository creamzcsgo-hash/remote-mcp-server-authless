import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

// Per Kalshi docs:
// Public data + RFQ creation/deletion → external-api.kalshi.com
// MVE creation + quote polling → api.elections.kalshi.com
const EXT  = "https://external-api.kalshi.com/trade-api/v2";
const ELEC = "https://api.elections.kalshi.com/trade-api/v2";

const SERIES: Record<string, string[]> = {
  worldcup: [
    "KXWCGAME","KXWCSPREAD","KXWCTOTAL","KXWCSCORE",
    "KXWCBTTS","KXWCTT","KXWC1H","KXWC1HSPREAD",
    "KXWC1HTOTAL","KXWC1HBTTS","KXWCGOAL","KXWCCORNERS","KXWCADVANCE",
  ],
  mlb: ["KXMLBGAME","KXMLBSPREAD","KXMLBTOTAL"],
  nba: ["KXNBAGAME"],
};

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
  // Sign path only — strip query string
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

// Public — no auth needed
async function pub(path: string): Promise<any> {
  const r = await fetch(`${EXT}${path}`, { headers:{ Accept:"application/json" } });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// Authenticated GET — api.elections.kalshi.com (quotes, etc)
async function aGET_elec(path: string, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("GET", path, kid, pk, false);
  const r = await fetch(`${ELEC}${path}`, { method:"GET", headers:h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// Authenticated POST — external-api (RFQ submit)
async function aPOST_ext(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("POST", path, kid, pk, true);
  const r = await fetch(`${EXT}${path}`, { method:"POST", headers:h, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// Authenticated DELETE — external-api (RFQ cancel)
async function aDEL_ext(path: string, kid: string, pk: CryptoKey): Promise<void> {
  const h = await sign("DELETE", path, kid, pk, false);
  await fetch(`${EXT}${path}`, { method:"DELETE", headers:h });
}

// Authenticated POST — api.elections (MVE creation)
async function aPOST_elec(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("POST", path, kid, pk, true);
  const r = await fetch(`${ELEC}${path}`, { method:"POST", headers:h, body:JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCents(s: string|undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  if (isNaN(v) || v === 0) return 0;
  // Kalshi returns dollar strings like "0.5600" = 56%
  return Math.round(v < 1.01 ? v * 100 : v);
}

interface Market {
  s: string; et: string; mt: string; t: string;
  yb: number; ya: number; nb: number; vol: number;
}

function extract(events: any[], series: string): Market[] {
  const out: Market[] = [];
  for (const ev of events ?? []) {
    for (const m of ev.markets ?? []) {
      if (m.status !== "active") continue;
      const yb = toCents(m.yes_bid_dollars);
      const ya = toCents(m.yes_ask_dollars);
      const nb = toCents(m.no_bid_dollars);
      if (yb === 0 && ya === 0 && nb === 0) continue;
      out.push({
        s: series, et: ev.event_ticker, mt: m.ticker,
        t: (m.yes_sub_title ?? m.title ?? "").slice(0,70),
        yb, ya, nb,
        vol: Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
      });
    }
  }
  return out;
}

async function fetchSeries(ticker: string): Promise<Market[]> {
  for (let i = 0; i < 3; i++) {
    try {
      const d = await pub(`/events?series_ticker=${ticker}&status=open&with_nested_markets=true`);
      return extract(d.events ?? [], ticker);
    } catch (e: any) {
      if (e.message.includes("429") && i < 2) {
        await new Promise(r => setTimeout(r, 2000 * (i+1)));
        continue;
      }
      return [];
    }
  }
  return [];
}

// ── Agent ─────────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name:"Kalshi Sports Connector", version:"3.1.0" });

  async init() {

    this.server.tool(
      "kalshi_get_all_today",
      "PRIMARY TOOL. Returns all open Kalshi markets across World Cup, MLB, and NBA — today and upcoming games. Grouped by game. Fields: s=series, et=event_ticker, mt=market_ticker, t=outcome title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Leg multiplier = 100/yb.",
      {},
      async () => {
        const out: Record<string,any> = {};
        for (const sport of ["worldcup","mlb","nba"] as const) {
          const byGame: Record<string,Market[]> = {};
          for (const ticker of SERIES[sport]) {
            const rows = await fetchSeries(ticker);
            for (const row of rows) (byGame[row.et] ??= []).push(row);
            await new Promise(r => setTimeout(r, 120));
          }
          out[sport] = {
            game_count: Object.keys(byGame).length,
            market_count: Object.values(byGame).flat().length,
            games: byGame,
          };
        }
        return { content:[{ type:"text", text:JSON.stringify(out) }] };
      }
    );

    this.server.tool(
      "kalshi_get_today_markets",
      "Returns all open markets for one sport only. Use kalshi_get_all_today for the full daily briefing.",
      { sport: z.enum(["worldcup","mlb","nba"]) },
      async ({ sport }) => {
        const byGame: Record<string,Market[]> = {};
        for (const ticker of SERIES[sport]) {
          const rows = await fetchSeries(ticker);
          for (const row of rows) (byGame[row.et] ??= []).push(row);
          await new Promise(r => setTimeout(r, 120));
        }
        return { content:[{ type:"text", text:JSON.stringify({
          sport,
          game_count: Object.keys(byGame).length,
          market_count: Object.values(byGame).flat().length,
          games: byGame,
        }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific game by event_ticker.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const d = await pub(`/events/${event_ticker}?with_nested_markets=true`);
        return { content:[{ type:"text", text:JSON.stringify({
          event_ticker,
          markets: extract([d.event ?? d], event_ticker),
        }) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Search for any Kalshi sports series ticker by keyword (corners, goalscorer, BTTS, home runs, etc).",
      { keyword: z.string() },
      async ({ keyword }) => {
        const d = await pub(`/series?category=Sports&limit=1000`);
        const kw = keyword.toLowerCase();
        const hits = ((d as any).series ?? [])
          .filter((s: any) =>
            (s.title ?? "").toLowerCase().includes(kw) ||
            (s.ticker ?? "").toLowerCase().includes(kw)
          )
          .slice(0,20)
          .map((s: any) => ({ ticker:s.ticker, title:s.title }));
        return { content:[{ type:"text", text:JSON.stringify({ keyword, results:hits }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_collections",
      "Find available combo collection tickers for a game event. Fallback: KXMVESPORTSMULTIGAMEEXTENDED-R.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const d = await pub(`/multivariate_event_collections?event_ticker=${event_ticker}&status=open`);
        const cols = (d as any).multivariate_contracts ?? [];
        return { content:[{ type:"text", text:JSON.stringify({
          collections: cols.map((c: any) => ({ collection_ticker:c.collection_ticker, title:c.title })),
          fallback: "KXMVESPORTSMULTIGAMEEXTENDED-R",
        }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_price",
      "Gets the real combo multiplier via Kalshi RFQ. Pass each leg's market_ticker, event_ticker, side, and yb (yes_bid from board). Always returns estimated_multiplier instantly. Submits live RFQ to market makers — returns real_multiplier if one responds. RFQ cancelled after, no trade placed.",
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

        // Always compute estimate from live passed-in prices
        const prices = legs.map(l => l.side === "no" ? 100 - l.yb : l.yb);
        const estMult = prices.reduce((a, p) => a * (100 / p), 1).toFixed(2);
        const base = {
          legs: legs.map(l => ({ mt:l.market_ticker, side:l.side, yb:l.yb })),
          prices,
          estimated_multiplier: `${estMult}x`,
          real_multiplier: null as string|null,
        };

        // Auth
        let kid: string, pk: CryptoKey;
        try {
          kid = this.env.KALSHI_KEY_ID;
          pk = await importKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", note:`Auth failed: ${e.message}`
          }) }] };
        }

        // MVE — api.elections.kalshi.com
        let mveTicker: string;
        try {
          const path = `/multivariate_event_collections/${collection_ticker}`;
          const h = await sign("POST", path, kid, pk, true);
          const r = await fetch(`${ELEC}${path}`, {
            method:"POST", headers:h,
            body:JSON.stringify({
              selected_markets: legs.map(l => ({
                market_ticker: l.market_ticker,
                event_ticker: l.event_ticker,
                side: l.side,
              })),
              with_market_payload: true,
            }),
          });
          const b = await r.json() as any;
          if (r.status === 409) {
            mveTicker = b.market_ticker ?? b.ticker ?? b.data?.market_ticker;
            if (!mveTicker) throw new Error(`409 but no ticker: ${JSON.stringify(b)}`);
          } else if (r.ok) {
            mveTicker = b.market_ticker ?? b.ticker;
            if (!mveTicker) throw new Error(`No ticker in response: ${JSON.stringify(b)}`);
          } else {
            throw new Error(`${r.status}: ${JSON.stringify(b)}`);
          }
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", note:`MVE failed: ${e.message}`
          }) }] };
        }

        // RFQ submit — external-api.kalshi.com (correct per docs)
        let rfqId: string;
        try {
          const res = await aPOST_ext(
            "/communications/rfqs",
            { market_ticker:mveTicker, contracts_fp:String(contracts) },
            kid, pk
          );
          rfqId = res.id ?? res.rfq?.rfq_id ?? res.rfq_id;
          if (!rfqId) throw new Error("No RFQ ID: " + JSON.stringify(res));
        } catch (e: any) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base, result:"estimate_only", mve:mveTicker,
            note:`RFQ submit failed: ${e.message}`
          }) }] };
        }

        // Poll quotes — api.elections.kalshi.com
        let bestBid: number|null = null;
        let bestNoBid: number|null = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const qr = await aGET_elec(
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              kid, pk
            );
            for (const q of (qr.quotes ?? qr.data ?? [])) {
              const raw = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = raw < 1.01 ? Math.round(raw * 100) : Math.round(raw);
              if (yb > 0 && (bestBid === null || yb > bestBid)) {
                bestBid = yb;
                const nr = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nr < 1.01 ? Math.round(nr * 100) : Math.round(nr);
              }
            }
            if (bestBid !== null) break;
          } catch (_) {}
        }

        // Cancel RFQ — external-api.kalshi.com
        try { await aDEL_ext(`/communications/rfqs/${rfqId}`, kid, pk); } catch (_) {}

        if (bestBid !== null) {
          return { content:[{ type:"text", text:JSON.stringify({
            ...base,
            result: "success",
            real_multiplier: `${(100 / bestBid).toFixed(2)}x`,
            real_yes_bid: bestBid,
            real_no_bid: bestNoBid,
            mve: mveTicker,
            note: "Real RFQ price from live market maker. RFQ cancelled — no trade placed.",
          }) }] };
        }

        return { content:[{ type:"text", text:JSON.stringify({
          ...base,
          result: "estimate_only",
          mve: mveTicker,
          rfq_id: rfqId,
          note: "No market maker response yet — estimated multiplier from live Kalshi prices.",
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
    return new Response("Kalshi Sports Connector v3.1", { status:200 });
  },
};
