import { McpAgent } from "agents/mcp";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const KALSHI_BASE = "https://api.elections.kalshi.com/trade-api/v2";

const SERIES: Record<string, string[]> = {
  worldcup: [
    "KXWCGAME", "KXWCSPREAD", "KXWCTOTAL", "KXWCSCORE",
    "KXWCBTTS", "KXWCTT", "KXWC1H", "KXWC1HSPREAD",
    "KXWC1HTOTAL", "KXWC1HBTTS", "KXWCGOAL", "KXWCCORNERS", "KXWCADVANCE",
  ],
  mlb: ["KXMLBGAME", "KXMLBSPREAD", "KXMLBTOTAL"],
  nba: ["KXNBAGAME"],
};

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  let decoded: string;
  try { decoded = atob(pem.trim()); }
  catch { throw new Error(`KALSHI_PRIVATE_KEY not valid base64. Starts: "${pem.substring(0, 40)}"`); }
  const body = decoded
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]+=*$/.test(body))
    throw new Error(`Key malformed. Starts: "${body.substring(0, 30)}"`);
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey(
    "pkcs8", der, { name: "RSA-PSS", hash: "SHA-256" }, false, ["sign"]
  );
}

async function makeHeaders(
  method: string, path: string, keyId: string, pk: CryptoKey, hasBody = false
): Promise<Record<string, string>> {
  const ts = Date.now().toString();
  const pathOnly = path.split("?")[0]; // sign path only, never query string
  const sig = await crypto.subtle.sign(
    { name: "RSA-PSS", saltLength: 32 }, pk,
    new TextEncoder().encode(ts + method.toUpperCase() + pathOnly)
  );
  const h: Record<string, string> = {
    Accept: "application/json",
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": btoa(String.fromCharCode(...new Uint8Array(sig))),
  };
  if (hasBody) h["Content-Type"] = "application/json";
  return h;
}

// ─── FETCH WRAPPERS ───────────────────────────────────────────────────────────

async function pub(path: string): Promise<any> {
  const r = await fetch(`${KALSHI_BASE}${path}`, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authGet(path: string, kid: string, pk: CryptoKey): Promise<any> {
  const h = await makeHeaders("GET", `/trade-api/v2${path}`, kid, pk, false);
  const r = await fetch(`${KALSHI_BASE}${path}`, { method: "GET", headers: h });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authPost(path: string, body: unknown, kid: string, pk: CryptoKey): Promise<any> {
  const h = await makeHeaders("POST", `/trade-api/v2${path}`, kid, pk, true);
  const r = await fetch(`${KALSHI_BASE}${path}`, { method: "POST", headers: h, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${await r.text()}`);
  return r.json();
}

async function authDelete(path: string, kid: string, pk: CryptoKey): Promise<void> {
  const h = await makeHeaders("DELETE", `/trade-api/v2${path}`, kid, pk, false);
  await fetch(`${KALSHI_BASE}${path}`, { method: "DELETE", headers: h });
}

// ─── COMPACT EXTRACTOR ────────────────────────────────────────────────────────

function compact(events: any[], series: string): any[] {
  const rows: any[] = [];
  for (const ev of events ?? []) {
    for (const m of ev.markets ?? []) {
      if (m.status !== "open") continue;
      rows.push({
        s: series,                          // series ticker
        et: ev.event_ticker,               // event ticker
        mt: m.ticker,                      // market ticker
        t: (m.title ?? m.subtitle ?? "").substring(0, 60),
        yb: m.yes_bid,                     // yes bid (0-100)
        ya: m.yes_ask,
        nb: m.no_bid,
        vol: m.volume,
      });
    }
  }
  return rows;
}

// Fetch one series with retry on 429
async function fetchSeries(ticker: string, retries = 2): Promise<any[]> {
  for (let i = 0; i <= retries; i++) {
    try {
      const d = await pub(
        `/events?series_ticker=${ticker}&status=open&with_nested_markets=true`
      );
      return compact(d.events ?? [], ticker);
    } catch (e: any) {
      if (e.message.includes("429") && i < retries) {
        await new Promise(r => setTimeout(r, 1500 * (i + 1))); // backoff
        continue;
      }
      return []; // swallow error, return empty
    }
  }
  return [];
}

// ─── AGENT ───────────────────────────────────────────────────────────────────

interface Env { KALSHI_KEY_ID: string; KALSHI_PRIVATE_KEY: string; }

export class MyMCP extends McpAgent<Env> {
  server = new McpServer({ name: "Kalshi Sports Data", version: "2.1.0" });

  async init() {

    // PRIMARY TOOL — single call gets everything, minimal token footprint
    this.server.tool(
      "kalshi_get_today_markets",
      "PRIMARY TOOL. Fetches ALL open markets for a sport today, server-side across all series, returns compact rows only. One call gets everything needed to build combos. Fields: s=series, et=event_ticker, mt=market_ticker, t=title, yb=yes_bid(0-100), ya=yes_ask, nb=no_bid, vol=volume. Multiplier=100/yb.",
      { sport: z.enum(["worldcup", "mlb", "nba"]) },
      async ({ sport }) => {
        const tickers = SERIES[sport];
        // Sequential with small gap to avoid rate limits
        const byEvent: Record<string, any[]> = {};
        for (const ticker of tickers) {
          const rows = await fetchSeries(ticker);
          for (const r of rows) {
            if (!byEvent[r.et]) byEvent[r.et] = [];
            byEvent[r.et].push(r);
          }
          await new Promise(res => setTimeout(res, 120)); // 120ms between series
        }
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              sport,
              games: byEvent,
              total: Object.values(byEvent).flat().length,
            }),
          }],
        };
      }
    );

    // ALL SPORTS IN ONE CALL — use for full daily briefing
    this.server.tool(
      "kalshi_get_all_today",
      "Fetches ALL open markets for World Cup + MLB + NBA in one call. Use this for the daily 8-combo briefing instead of calling kalshi_get_today_markets three times.",
      {},
      async () => {
        const allSports = ["worldcup", "mlb", "nba"] as const;
        const result: Record<string, any> = {};

        for (const sport of allSports) {
          const tickers = SERIES[sport];
          const byEvent: Record<string, any[]> = {};
          for (const ticker of tickers) {
            const rows = await fetchSeries(ticker);
            for (const r of rows) {
              if (!byEvent[r.et]) byEvent[r.et] = [];
              byEvent[r.et].push(r);
            }
            await new Promise(res => setTimeout(res, 120));
          }
          result[sport] = {
            games: byEvent,
            total: Object.values(byEvent).flat().length,
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify(result),
          }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_event",
      "Deep dive on one specific game event. Only use when kalshi_get_today_markets data isn't enough.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await pub(`/events/${event_ticker}?with_nested_markets=true`);
        const ev = data.event ?? data;
        const markets = compact([ev], event_ticker);
        return { content: [{ type: "text", text: JSON.stringify({ event_ticker, markets }) }] };
      }
    );

    this.server.tool(
      "kalshi_search_series",
      "Find any Kalshi sports series ticker by keyword (corners, goalscorer, props etc).",
      { keyword: z.string() },
      async ({ keyword }) => {
        const data = await pub(`/series?category=Sports&limit=1000`);
        const kw = keyword.toLowerCase();
        const matches = ((data as any).series ?? [])
          .filter((s: any) =>
            (s.title ?? "").toLowerCase().includes(kw) ||
            (s.ticker ?? "").toLowerCase().includes(kw)
          )
          .slice(0, 20)
          .map((s: any) => ({ ticker: s.ticker, title: s.title }));
        return { content: [{ type: "text", text: JSON.stringify({ keyword, matches }) }] };
      }
    );

    this.server.tool(
      "kalshi_get_combo_collections",
      "Find combo collection tickers for a game event. Use before kalshi_get_combo_price if needed. Default fallback: KXMVESPORTSMULTIGAMEEXTENDED-R.",
      { event_ticker: z.string() },
      async ({ event_ticker }) => {
        const data = await pub(
          `/multivariate_event_collections?event_ticker=${event_ticker}&status=open`
        );
        const cols = (data as any).multivariate_contracts ?? [];
        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              collections: cols.map((c: any) => ({ collection_ticker: c.collection_ticker, title: c.title })),
              fallback: "KXMVESPORTSMULTIGAMEEXTENDED-R",
            }),
          }],
        };
      }
    );

    this.server.tool(
      "kalshi_get_combo_price",
      "Submit a real Kalshi RFQ and return the live quoted multiplier. RFQ cancelled after — no trade placed. Default collection: KXMVESPORTSMULTIGAMEEXTENDED-R.",
      {
        collection_ticker: z.string().default("KXMVESPORTSMULTIGAMEEXTENDED-R"),
        selected_markets: z.array(z.object({
          market_ticker: z.string(),
          event_ticker: z.string(),
          side: z.enum(["yes", "no"]).default("yes"),
        })).min(2).max(4),
        contracts: z.number().int().min(1).max(100).default(1),
      },
      async ({ collection_ticker, selected_markets, contracts }) => {
        let kid: string;
        let pk: CryptoKey;
        try {
          kid = this.env.KALSHI_KEY_ID;
          pk = await importPrivateKey(this.env.KALSHI_PRIVATE_KEY);
        } catch (e: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "Auth failed", detail: e.message }) }] };
        }

        // Step 1: Create or reuse MVE (409 = already exists, extract ticker)
        let mveTicker: string;
        try {
          const mveH = await makeHeaders(
            "POST",
            `/trade-api/v2/multivariate_event_collections/${collection_ticker}`,
            kid, pk, true
          );
          const mveRes = await fetch(
            `${KALSHI_BASE}/multivariate_event_collections/${collection_ticker}`,
            { method: "POST", headers: mveH, body: JSON.stringify({ selected_markets, with_market_payload: true }) }
          );
          const mveBody = await mveRes.json() as any;
          if (mveRes.status === 409) {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker ?? mveBody.data?.market_ticker;
            if (!mveTicker) throw new Error(`409 no ticker: ${JSON.stringify(mveBody)}`);
          } else if (!mveRes.ok) {
            throw new Error(`${mveRes.status}: ${JSON.stringify(mveBody)}`);
          } else {
            mveTicker = mveBody.market_ticker ?? mveBody.ticker;
            if (!mveTicker) throw new Error(`No ticker: ${JSON.stringify(mveBody)}`);
          }
        } catch (e: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "MVE failed", detail: e.message }) }] };
        }

        // Step 2: Submit RFQ
        let rfqId: string;
        try {
          const rfqRes = await authPost(
            "/communications/rfqs",
            { market_ticker: mveTicker, contracts_fp: contracts.toString() },
            kid, pk
          );
          rfqId = rfqRes.id ?? rfqRes.rfq?.rfq_id ?? rfqRes.rfq_id;
          if (!rfqId) throw new Error("No ID: " + JSON.stringify(rfqRes));
        } catch (e: any) {
          return { content: [{ type: "text", text: JSON.stringify({ error: "RFQ failed", detail: e.message, mve: mveTicker }) }] };
        }

        // Step 3: Poll quotes — GET uses path-only signing, no Content-Type
        let bestYesBid: number | null = null;
        let bestNoBid: number | null = null;
        let lastRes: unknown = null;
        for (let i = 0; i < 10; i++) {
          await new Promise(r => setTimeout(r, 1000));
          try {
            const qRes = await authGet(
              `/communications/quotes?rfq_id=${rfqId}&user_filter=self`,
              kid, pk
            );
            lastRes = qRes;
            for (const q of (qRes.quotes ?? qRes.data ?? [])) {
              const ybRaw = parseFloat(q.yes_bid_dollars ?? q.yes_price_dollars ?? "0");
              const yb = ybRaw > 1 ? Math.round(ybRaw) : Math.round(ybRaw * 100);
              if (yb > 0 && (bestYesBid === null || yb > bestYesBid)) {
                bestYesBid = yb;
                const nbRaw = parseFloat(q.no_bid_dollars ?? q.no_price_dollars ?? "0");
                bestNoBid = nbRaw > 1 ? Math.round(nbRaw) : Math.round(nbRaw * 100);
              }
            }
            if (bestYesBid !== null) break;
          } catch (e: any) { lastRes = { err: e.message }; }
        }

        // Step 4: Cancel RFQ
        try { await authDelete(`/communications/rfqs/${rfqId}`, kid, pk); } catch (_) {}

        if (bestYesBid === null) {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                result: "no_quote",
                rfq_id: rfqId,
                mve: mveTicker,
                legs: selected_markets.map(m => m.market_ticker),
                last: lastRes,
                note: "No market maker active yet. Present as estimated multiplier.",
              }),
            }],
          };
        }

        return {
          content: [{
            type: "text",
            text: JSON.stringify({
              result: "success",
              legs: selected_markets.map(m => m.market_ticker),
              mve: mveTicker,
              yes_bid: bestYesBid,
              no_bid: bestNoBid,
              multiplier: `${(100 / bestYesBid).toFixed(2)}x`,
              note: "REAL RFQ price. No trade placed.",
            }),
          }],
        };
      }
    );
  }
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === "/sse" || url.pathname === "/sse/message") return MyMCP.serveSSE("/sse").fetch(request, env, ctx);
    if (url.pathname === "/mcp") return MyMCP.serve("/mcp").fetch(request, env, ctx);
    return new Response("Not found", { status: 404 });
  },
};
