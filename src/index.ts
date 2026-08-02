import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const EXT  = "https://external-api.kalshi.com/trade-api/v2";
const ELEC = "https://api.elections.kalshi.com/trade-api/v2";

// All MLB series — game markets + all player props
const MLB_SERIES = [
  "KXMLBGAME",    // moneyline
  "KXMLBSPREAD",  // run line / margin
  "KXMLBTOTAL",   // total runs
  "KXMLBF5TOTAL", // first 5 innings total
  "KXMLBHR",      // home runs
  "KXMLBKS",      // strikeouts
  "KXMLBHIT",     // hits
  "KXMLBHRR",     // hits + runs + RBIs
  "KXMLBTB",      // total bases
  "KXMLBOUTS",    // outs recorded
  "KXMLBRBI",     // RBIs
  "KXMLBSB",      // stolen bases
];

const NBA_SERIES = [
  "KXNBAGAME","KXNBASPREAD","KXNBATOTAL",
  "KXNBASUMMERGAME","KXNBASUMMERSPREAD","KXNBASUMMERTOTAL",
];

const DEAD_STATUSES = new Set(["finalized","settled","determined","closed"]);

// ── Auth ──────────────────────────────────────────────────────────────────────

async function importKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try { decoded = atob(pem.trim()); }
  catch { throw new Error("PEM not valid base64"); }
  const body = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]
  );
}

async function sign(
  method: string, path: string, kid: string, pk: CryptoKey, hasBody = false
): Promise<Record<string, string>> {
  const ts = Date.now().toString();
  const pathOnly = `/trade-api/v2${path}`.split("?")[0];
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, pk,
    new TextEncoder().encode(ts + method.toUpperCase() + pathOnly)
  );
  const h: Record<string, string> = {
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
  const r = await fetch(`${EXT}${path}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function aGET(path: string, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("GET", path, kid, pk, false);
  const r = await fetch(`${ELEC}${path}`, { method: "GET", headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function aPOST_ext(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await sign("POST", path, kid, pk, true);
  const r = await fetch(`${EXT}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function aDEL_ext(path: string, kid: string, pk: CryptoKey): Promise<void> {
  const h = await sign("DELETE", path, kid, pk, false);
  await fetch(`${EXT}${path}`, { method: "DELETE", headers: h });
}

// ── Price helper ──────────────────────────────────────────────────────────────

function cents(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  return isNaN(v) ? 0 : Math.round(v < 1.01 ? v * 100 : v);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Step 1: get all event tickers for a series + date (no nested markets needed)
async function getEventTickers(ticker: string, date: string): Promise<string[]> {
  const tickers: string[] = [];
  const dateUpper = date.toUpperCase();
  try {
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const cp = cursor ? `&cursor=${cursor}` : "";
      // No status filter — games in progress move from "open" to "active"
      // so filtering by status=open misses live games
      const d = await pub(`/events?series_ticker=${ticker}${cp}`);
      for (const ev of d.events ?? []) {
        const et = ev.event_ticker ?? "";
        if (et.includes(dateUpper)) tickers.push(et);
      }
      cursor = d.cursor ?? "";
      if (!cursor || (d.events ?? []).length === 0) break;
    }
  } catch { /* skip */ }
  return tickers;
}

// Step 2: fetch all markets for one event directly (always works)
async function getEventMarkets(eventTicker: string, seriesTicker: string): Promise<any[]> {
  const markets: any[] = [];
  try {
    const d = await pub(`/events/${eventTicker}?with_nested_markets=true`);
    for (const m of (d.event ?? d).markets ?? []) {
      if (DEAD_STATUSES.has((m.status ?? "").toLowerCase())) continue;
      const yb = cents(m.yes_bid_dollars);
      const ya = cents(m.yes_ask_dollars);
      const nb = cents(m.no_bid_dollars);
      markets.push({
        s: seriesTicker, et: eventTicker, mt: m.ticker,
        t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
        yb, ya, nb, status: m.status,
        vol: Math.round(parseFloat(String(m.volume_fp ?? m.open_interest_fp ?? 0))),
      });
    }
  } catch { /* skip */ }
  return markets;
}

// ── Agent ─────────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Connector", version: "13.0.0" });

  async init() {

    this.server.tool(
      "kalshi_get_all_today",
      "PRIMARY TOOL. Gets all open Kalshi markets for MLB and NBA for a specific date — moneyline, spread/margin, totals, F5 total, and all player props (HR, Ks, hits, HRR, total bases, outs, RBI, SB). Pass date as YYMONDD e.g. '26AUG02'. Returns live markets grouped by game with real prices. Fields: mt=market_ticker, et=event_ticker, s=series, t=title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Multiplier = 100/yb.",
      { date: z.string().describe("Date in YYMONDD format e.g. 26AUG02") },
      async ({ date }) => {
        const mlb: Record<string, any[]> = {};
        const nba: Record<string, any[]> = {};

        for (const ticker of MLB_SERIES) {
          // Get event tickers for this series + date
          const eventTickers = await getEventTickers(ticker, date);
          await delay(300);
          // Fetch each event directly
          for (const et of eventTickers) {
            const markets = await getEventMarkets(et, ticker);
            if (markets.length > 0) (mlb[et] ??= []).push(...markets);
            await delay(200);
          }
        }

        for (const ticker of NBA_SERIES) {
          const eventTickers = await getEventTickers(ticker, date);
          await delay(300);
          for (const et of eventTickers) {
            const markets = await getEventMarkets(et, ticker);
            if (markets.length > 0) (nba[et] ??= []).push(...markets);
            await delay(200);
          }
        }

        const out: Record<string, any> = {};
        if (Object.keys(mlb).length > 0) {
          out.mlb = {
            game_count: Object.keys(mlb).length,
            market_count: Object.values(mlb).flat().length,
            available_series: [...new Set(Object.values(mlb).flat().map((m: any) => m.s))],
            games: mlb,
          };
        }
        if (Object.keys(nba).length > 0) {
          out.nba = {
            game_count: Object.keys(nba).length,
            market_count: Object.values(nba).flat().length,
            available_series: [...new Set(Object.values(nba).flat().map((m: any) => m.s))],
            games: nba,
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              Object.keys(out).length > 0
                ? out
                : { note: `No open markets found for ${date}.` }
            ),
          }],
        };
      }
    );

    // SINGLE GAME — all markets for one event ticker
    this.server.tool(
      "kalshi_get_event",
      "Get all open markets for one specific game by its full event_ticker e.g. KXMLBGAME-26AUG01STLTOR.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        try {
          const d = await pub(`/events/${event_ticker}?with_nested_markets=true`);
          const ev = d.event ?? d;
          const markets: any[] = [];
          for (const m of ev.markets ?? []) {
            if (DEAD_STATUSES.has((m.status ?? "").toLowerCase())) continue;
            const yb = cents(m.yes_bid_dollars);
            const ya = cents(m.yes_ask_dollars);
            const nb = cents(m.no_bid_dollars);
            markets.push({
              s: m.series_ticker ?? "", et: event_ticker, mt: m.ticker,
              t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
              yb, ya, nb, status: m.status,
              vol: Math.round(parseFloat(String(m.volume_fp ?? 0))),
            });
          }
          return {
            content: [{
              type: "text",
              text: JSON.stringify({ event_ticker, market_count: markets.length, markets }),
            }],
          };
        } catch (e: any) {
          return {
            content: [{ type: "text", text: JSON.stringify({ error: e.message, event_ticker }) }],
          };
        }
      }
    );

    // SERIES SEARCH — find any series ticker by keyword
    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi sports series by keyword to find any market or prop type.",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await pub(`/series?category=Sports&limit=1000`);
        const kw = keyword.toLowerCase();
        const hits = ((data as any).series ?? [])
          .filter((s: any) =>
            (s.title ?? "").toLowerCase().includes(kw) ||
            (s.ticker ?? "").toLowerCase().includes(kw)
          )
          .slice(0, 20)
          .map((s: any) => ({ ticker: s.ticker, title: s.title }));
        return {
          content: [{ type: "text", text: JSON.stringify({ keyword, results: hits }) }],
        };
      }
    );

    // COMBO PRICE — estimated always, real RFQ when market makers active
    this.server.tool(
      "kalshi_get_combo_price",
      "Gets the real combo multiplier via Kalshi RFQ. Always returns estimated_multiplier instantly from the yb values you pass. Also submits a live RFQ — returns real_multiplier if market makers respond. Pass yb from board data for each leg. RFQ cancelled after — no trade placed.",
      {
        collection_ticker: z.string().default("KXMVESPORTSMULTIGAMEEXTENDED-R"),
        legs: z.array(z.object({
          market_ticker: z.string(),
          event_ticker: z.string(),
          side: z.enum(["yes", "no"]).default("yes"),
          yb: z.number().int().min(1).max(99),
        })).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ collection_ticker, legs, contracts }) => {
        // Estimated multiplier — always instant
        const prices = legs.map(l => l.side === "no" ? 100 - l.yb : l.yb);
        const estMult = prices.reduce((a, p) => a * (100 / p), 1).toFixed(2);
        const base = {
          legs: legs.map(l => ({ mt: l.market_ticker, side: l.side, yb: l.yb })),
          prices,
          estimated_multiplier: `${estMult}x`,
          real_multiplier: null as string | null,
        };

        // Auth
        let kid: string, pk: CryptoKey;
        try {
          kid = this.env.KALSHI_KEY_ID;
          pk = await importKey(this.env.KALSHI_PRIVATE_KEY);
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ ...base, result: "estimate_only" }) }] };
        }

        // Create MVE
        let mveTicker: string;
        try {
          const path = `/multivariate_event_collections/${collection_ticker}`;
          const h = await sign("POST", path, kid, pk, true);
          const r = await fetch(`${ELEC}${path}`, {
            method: "POST", headers: h,
            body: JSON.stringify({
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
          } else if (r.ok) {
            mveTicker = b.market_ticker ?? b.ticker;
          } else {
            throw new Error(`${r.status}`);
          }
          if (!mveTicker!) throw new Error("no ticker");
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ ...base, result: "estimate_only" }) }] };
        }

        // Submit RFQ
        let rfqId: string;
        try {
          const res = await aPOST_ext(
            "/communications/rfqs",
            { market_ticker: mveTicker, contracts_fp: String(contracts) },
            kid, pk
          );
          rfqId = res.id ?? res.rfq?.rfq_id ?? res.rfq_id;
          if (!rfqId) throw new Error("no id");
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ ...base, result: "estimate_only", mve: mveTicker }) }] };
        }

        // Poll for quotes (10 seconds)
        let bestBid: number | null = null;
        let bestNoBid: number | null = null;
        for (let i = 0; i < 10; i++) {
          await delay(1000);
          try {
            const qr = await aGET(`/communications/quotes?rfq_id=${rfqId}&user_filter=self`, kid, pk);
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

        // Cancel RFQ — no trade placed
        try { await aDEL_ext(`/communications/rfqs/${rfqId}`, kid, pk); } catch (_) {}

        if (bestBid !== null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                ...base, result: "success",
                real_multiplier: `${(100 / bestBid).toFixed(2)}x`,
                real_yes_bid: bestBid, real_no_bid: bestNoBid, mve: mveTicker,
              }),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({ ...base, result: "estimate_only", mve: mveTicker }),
          }],
        };
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
    return new Response("Kalshi Sports Connector v13.0", { status: 200 });
  },
};
