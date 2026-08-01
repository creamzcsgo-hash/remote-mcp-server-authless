import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const EXT  = "https://external-api.kalshi.com/trade-api/v2";
const ELEC = "https://api.elections.kalshi.com/trade-api/v2";

const MLB_GAME_SERIES = ["KXMLBGAME","KXMLBSPREAD","KXMLBTOTAL","KXMLBF5TOTAL"];
const NBA_GAME_SERIES = ["KXNBAGAME","KXNBASPREAD","KXNBATOTAL","KXNBASUMMERGAME","KXNBASUMMERSPREAD","KXNBASUMMERTOTAL"];
const MLB_PROP_SERIES = ["KXMLBHR","KXMLBKS","KXMLBHIT","KXMLBHRR","KXMLBTB","KXMLBOUTS","KXMLBRBI","KXMLBSB"];

// ── Auth ──────────────────────────────────────────────────────────────────────

async function importKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try { decoded = atob(pem.trim()); }
  catch { throw new Error(`PEM not valid base64`); }
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

// ── Helpers ───────────────────────────────────────────────────────────────────

function toCents(s: string | undefined): number {
  if (!s) return 0;
  const v = parseFloat(s);
  if (isNaN(v) || v === 0) return 0;
  return Math.round(v < 1.01 ? v * 100 : v);
}

const delay = (ms: number) => new Promise(r => setTimeout(r, ms));

// Fetch one series, filter by date string (e.g. "26AUG01"), return markets grouped by event
async function fetchSeries(ticker: string, dateFilter?: string): Promise<Record<string, any[]>> {
  const byGame: Record<string, any[]> = {};
  try {
    // Use /markets endpoint directly — this returns prices, /events nested markets does not
    let cursor = "";
    for (let page = 0; page < 5; page++) {
      const cp = cursor ? `&cursor=${cursor}` : "";
      const d = await pub(`/markets?series_ticker=${ticker}&limit=200${cp}`);
      const markets: any[] = d.markets ?? [];
      for (const m of markets) {
        const et: string = m.event_ticker ?? "";
        if (dateFilter && !et.includes(dateFilter.toUpperCase())) continue;
        // Skip any market that is closed/finalized
        const mStatus = (m.status ?? "").toLowerCase();
        if (mStatus === "finalized" || mStatus === "settled" || mStatus === "determined" || mStatus === "closed") continue;
        const yb = toCents(m.yes_bid_dollars);
        const ya = toCents(m.yes_ask_dollars);
        const nb = toCents(m.no_bid_dollars);
        const status = (m.status ?? "").toLowerCase();
        if (status === "finalized" || status === "settled" || status === "determined") continue;
        if (yb === 0 && ya === 0 && nb === 0) continue;
        if (!byGame[et]) byGame[et] = [];
        byGame[et].push({
          s: ticker, et, mt: m.ticker,
          t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
          yb, ya, nb,
          vol: Math.round(parseFloat(String(m.open_interest_fp ?? m.volume ?? 0))),
        });
      }
      cursor = d.cursor ?? "";
      if (!cursor || markets.length < 200) break;
      await delay(200);
    }
  // If event came back with no nested markets, fetch it directly
    for (const ev of d.events ?? []) {
      const et: string = ev.event_ticker ?? "";
      if (dateFilter && !et.includes(dateFilter.toUpperCase())) continue;
      if (byGame[et]) continue; // already got markets for this event
      try {
        const evData = await pub(`/events/${et}?with_nested_markets=true`);
        for (const m of (evData.event ?? evData).markets ?? []) {
          const yb = toCents(m.yes_bid_dollars);
          const ya = toCents(m.yes_ask_dollars);
          const nb = toCents(m.no_bid_dollars);
          if (yb === 0 && ya === 0 && nb === 0) continue;
          (byGame[et] ??= []).push({
            s: ticker, et, mt: m.ticker,
            t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
            yb, ya, nb,
            vol: Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
          });
        }
        await delay(200);
      } catch { /* skip */ }
    }
  } catch { /* skip on error */ }
  return byGame;
}

function merge(target: Record<string, any[]>, source: Record<string, any[]>) {
  for (const [et, markets] of Object.entries(source)) {
    (target[et] ??= []).push(...markets);
  }
}

// ── Agent ─────────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Connector", version: "12.0.0" });

  async init() {

    // ── GET GAMES FOR A DATE ─────────────────────────────────────────────────
    this.server.tool(
      "kalshi_get_all_today",
      "PRIMARY TOOL. Gets all open MLB and NBA game markets (moneyline, spread, total, F5) for a specific date. Pass date as YYMONDD e.g. '26AUG01' for Aug 1 2026, '26AUG03' for Aug 3. Returns markets grouped by game event_ticker. Fields: mt=market_ticker, et=event_ticker, s=series, t=title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Multiplier = 100/yb.",
      { date: z.string().describe("Date in YYMONDD format e.g. 26AUG01") },
      async ({ date }) => {
        const mlb: Record<string, any[]> = {};
        const nba: Record<string, any[]> = {};

        for (const ticker of MLB_GAME_SERIES) {
          merge(mlb, await fetchSeries(ticker, date));
          await delay(300);
        }
        for (const ticker of NBA_GAME_SERIES) {
          merge(nba, await fetchSeries(ticker, date));
          await delay(300);
        }

        const out: Record<string, any> = {};
        if (Object.keys(mlb).length > 0) out.mlb = {
          game_count: Object.keys(mlb).length,
          market_count: Object.values(mlb).flat().length,
          games: mlb,
        };
        if (Object.keys(nba).length > 0) out.nba = {
          game_count: Object.keys(nba).length,
          market_count: Object.values(nba).flat().length,
          games: nba,
        };

        return {
          content: [{
            type: "text",
            text: JSON.stringify(
              Object.keys(out).length > 0
                ? out
                : { note: `No open markets found for ${date}. Try a different date or check back closer to game time.` }
            ),
          }],
        };
      }
    );

    // ── GET PLAYER PROPS FOR ONE GAME ────────────────────────────────────────
    this.server.tool(
      "kalshi_get_game_props",
      "Gets all MLB player props (HR, strikeouts, hits, HRR, total bases, outs recorded, RBI, stolen bases) for one specific game. Pass the game_code — the team+date portion from the event_ticker e.g. '26AUG01NYYBOS' from 'KXMLBGAME-26AUG01NYYBOS'. Only call this for games you are actually building a combo for.",
      { game_code: z.string().describe("Team+date code from event_ticker e.g. 26AUG01NYYBOS") },
      async ({ game_code }) => {
        const props: any[] = [];
        const code = game_code.toUpperCase();
        for (const ticker of MLB_PROP_SERIES) {
          try {
            const d = await pub(`/events?series_ticker=${ticker}&status=open&with_nested_markets=true`);
            for (const ev of d.events ?? []) {
              if (!(ev.event_ticker ?? "").includes(code)) continue;
              for (const m of ev.markets ?? []) {
                const yb = toCents(m.yes_bid_dollars);
                const ya = toCents(m.yes_ask_dollars);
                const nb = toCents(m.no_bid_dollars);
                if (yb === 0 && ya === 0 && nb === 0) continue;
                props.push({
                  s: ticker, et: ev.event_ticker, mt: m.ticker,
                  t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
                  yb, ya, nb,
                  vol: Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
                });
              }
            }
          } catch { /* skip */ }
          await delay(300);
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ game_code, prop_count: props.length, props }),
          }],
        };
      }
    );

    // ── GET ONE SPECIFIC GAME ────────────────────────────────────────────────
    this.server.tool(
      "kalshi_get_event",
      "Get all markets for one specific game by its full event_ticker e.g. KXMLBGAME-26AUG01NYYBOS.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const d = await pub(`/events/${event_ticker}?with_nested_markets=true`);
        const ev = d.event ?? d;
        const markets: any[] = [];
        for (const m of ev.markets ?? []) {
          const yb = toCents(m.yes_bid_dollars);
          const ya = toCents(m.yes_ask_dollars);
          const nb = toCents(m.no_bid_dollars);
          if (yb === 0 && ya === 0 && nb === 0) continue;
          markets.push({
            s: m.series_ticker ?? "", et: event_ticker, mt: m.ticker,
            t: (m.yes_sub_title ?? m.title ?? "").slice(0, 70),
            yb, ya, nb,
            vol: Math.round(parseFloat(String(m.volume_fp ?? m.volume ?? 0))),
          });
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({ event_ticker, market_count: markets.length, markets }),
          }],
        };
      }
    );

    // ── SEARCH FOR ANY SERIES ────────────────────────────────────────────────
    this.server.tool(
      "kalshi_search_series",
      "Search Kalshi sports series by keyword to find any market type or prop series.",
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
          content: [{
            type: "text",
            text: JSON.stringify({ keyword, results: hits }),
          }],
        };
      }
    );

    // ── GET COMBO MULTIPLIER + REAL RFQ PRICE ────────────────────────────────
    this.server.tool(
      "kalshi_get_combo_price",
      "Gets the combo multiplier for 2-4 legs. Always returns estimated_multiplier instantly from the yb values you pass. Also submits a live RFQ to get real_multiplier from market makers if active. Pass the yb value from board data for each leg. RFQ is cancelled after pricing — no trade is placed.",
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
        // Estimated multiplier — always instant from passed yb values
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

        // Create MVE (multivariate event) — api.elections.kalshi.com
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
            throw new Error(`${r.status}: ${JSON.stringify(b)}`);
          }
          if (!mveTicker!) throw new Error("no ticker in response");
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ ...base, result: "estimate_only" }) }] };
        }

        // Submit RFQ — external-api.kalshi.com
        let rfqId: string;
        try {
          const res = await aPOST_ext(
            "/communications/rfqs",
            { market_ticker: mveTicker, contracts_fp: String(contracts) },
            kid, pk
          );
          rfqId = res.id ?? res.rfq?.rfq_id ?? res.rfq_id;
          if (!rfqId) throw new Error("no rfq id");
        } catch {
          return { content: [{ type: "text", text: JSON.stringify({ ...base, result: "estimate_only", mve: mveTicker }) }] };
        }

        // Poll for quotes — api.elections.kalshi.com, sign path only (no query string)
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

// ── Entry point ───────────────────────────────────────────────────────────────

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message")
      return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    if (url.pathname === "/mcp")
      return MyMCP.serve("/mcp").fetch(request, env, ctx);
    return new Response("Kalshi Sports Connector v12.0", { status: 200 });
  },
};
