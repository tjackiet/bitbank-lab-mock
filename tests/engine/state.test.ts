import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { defaultStatePath, loadState, saveState } from "../../src/engine/persist.ts";
import {
  amountOf,
  availableOf,
  computeLocked,
  DEFAULT_TAKER_FEE_RATE,
  genId,
  latestRecordMs,
  nowIso,
  PaperStateSchema,
  pairAssets,
} from "../../src/engine/state.ts";
import { placeOrder } from "../../src/engine/transitions.ts";
import { buildOrder, buildState, buildTrade } from "./helpers.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bitbank-mock-state-"));
  statePath = join(dir, "state.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("schema", () => {
  it("validates a fresh v3 state", () => {
    const parsed = PaperStateSchema.safeParse(buildState());
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown version", () => {
    const parsed = PaperStateSchema.safeParse({ ...buildState(), version: 99 });
    expect(parsed.success).toBe(false);
  });
});

describe("pure helpers", () => {
  it("nowIso returns ISO8601 with ms+Z", () => {
    expect(nowIso()).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("genId is unique enough across rapid calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => genId()));
    expect(ids.size).toBe(200);
  });

  it("computeLocked: buy locks quote with fee, sell locks base", () => {
    const state = buildState({
      orders: [
        buildOrder({ id: "b", side: "buy", pair: "btc_jpy", price: 1000, startAmount: 2 }),
        buildOrder({ id: "s", side: "sell", pair: "btc_jpy", price: 1000, startAmount: 0.5 }),
      ],
    });
    const locked = computeLocked(state, 0.001);
    expect(locked.jpy).toBeCloseTo(1000 * 2 * 1.001, 6);
    expect(locked.btc).toBeCloseTo(0.5, 6);
  });

  // 素の {} は Object.prototype を継承するので、`constructor` を base に持つペアでは
  // `locked["constructor"] ?? 0` が関数を掴み、拘束額が文字列連結になっていた。
  // ペアのセグメントは [a-z0-9]+ なので、この名前で当たるのは `constructor` だけ。
  it("computeLocked: Object.prototype のキーと同名の資産でも数値で積む", () => {
    const state = buildState({
      balances: { jpy: 1_000_000 },
      orders: [
        buildOrder({
          id: "s",
          side: "sell",
          pair: "constructor_jpy",
          price: 100,
          startAmount: 999,
        }),
      ],
    });
    const locked = computeLocked(state, 0);
    expect(locked.constructor).toBe(999);
    expect(Object.keys(locked)).toEqual(["constructor"]);
  });

  it("availableOf: Object.prototype のキーと同名の資産でも NaN にならない", () => {
    const state = buildState({
      balances: { jpy: 1_000_000 },
      orders: [
        buildOrder({
          id: "s",
          side: "sell",
          pair: "constructor_jpy",
          price: 100,
          startAmount: 999,
        }),
      ],
    });
    // 残高に constructor が無いので 0。拘束 999 を引いて -999。NaN だと発注ガードが素通りする。
    expect(availableOf(state, "constructor", 0)).toBe(-999);
    expect(amountOf(state.balances, "constructor")).toBe(0);
    expect(amountOf({ constructor: 3 }, "constructor")).toBe(3);
  });

  it("availableOf subtracts locked from total", () => {
    const state = buildState({
      balances: { jpy: 1_000_000, btc: 1 },
      orders: [buildOrder({ id: "b", side: "buy", price: 100_000, startAmount: 1 })],
    });
    expect(availableOf(state, "jpy", 0)).toBe(900_000);
    expect(availableOf(state, "btc", 0)).toBe(1);
  });

  it("DEFAULT_TAKER_FEE_RATE matches bitbank docs", () => {
    expect(DEFAULT_TAKER_FEE_RATE).toBe(0.0012);
  });

  it("pairAssets accepts exactly two non-empty segments", () => {
    expect(pairAssets("btc_jpy")).toEqual(["btc", "jpy"]);
    expect(pairAssets("btc")).toBeNull();
    expect(pairAssets("btc_jpy_x")).toBeNull();
    expect(pairAssets("_jpy")).toBeNull();
    expect(pairAssets("jpy_jpy")).toBeNull();
  });

  // 記号を含むペアは外向き URL のパスへ流れる（src/engine/candles.ts の fetchOneDay）。
  // `..` は接頭辞を脱出し、`?` / `#` は以降をクエリ・フラグメントに変える。
  it("pairAssets rejects segments that are not lowercase alphanumeric", () => {
    expect(pairAssets("../../admin_jpy")).toBeNull();
    expect(pairAssets("btc?a=1_jpy")).toBeNull();
    expect(pairAssets("btc#frag_jpy")).toBeNull();
    expect(pairAssets("btc/x_jpy")).toBeNull();
    expect(pairAssets("btc%2f_jpy")).toBeNull();
    expect(pairAssets("btc-x_jpy")).toBeNull();
    expect(pairAssets("btc x_jpy")).toBeNull();
    expect(pairAssets("BTC_JPY")).toBeNull();
  });

  // 制御文字・改行を含むペア。`$` は入力の末尾にだけ合致するので、末尾の改行も弾く。
  it("pairAssets rejects control characters and newlines", () => {
    expect(pairAssets("btc\n_jpy")).toBeNull();
    expect(pairAssets("btc_jpy\n")).toBeNull();
    expect(pairAssets("btc\r\nx_jpy")).toBeNull();
    expect(pairAssets("btc\u0000_jpy")).toBeNull();
  });

  // **`pairAssets` 自体はホワイトリストではない。** 見るのは形（文字種と 2 セグメント）
  // だけで、公式一覧（pairs.md）に無くても形が正しければ通す。実在性は route 層の
  // `isKnownPair()`（`src/engine/pairs.ts`）が見るので、ここを通るペアでも
  // `GET order` などは 40017 で断られる。**層が違うだけで、モックは一覧を持っている。**
  // 数字を許すのは、bitbank が数字入りのペアを足したときに弾かないための保守的な上限。
  it("pairAssets accepts well-formed pairs that are not in the official list", () => {
    expect(pairAssets("foo_jpy")).toEqual(["foo", "jpy"]);
    expect(pairAssets("1inch_jpy")).toEqual(["1inch", "jpy"]);
    expect(pairAssets("abc123_xyz9")).toEqual(["abc123", "xyz9"]);
  });
});

/**
 * 「記録」の時刻の最大（`docs/plan-lab-mock.md` 17.2 の決定 28）。仮想時計の
 * `POST /_control/clock` が、時計をこれより前へ置くのを断る。
 */
describe("latestRecordMs", () => {
  const at = (s: string) => Date.parse(s);

  it("記録が無ければ null", () => {
    expect(latestRecordMs(buildState())).toBeNull();
  });

  it("orderedAt / canceledAt / trade の executedAt の最大を取る", () => {
    const base = buildState({
      orders: [
        buildOrder({ id: "1", orderedAt: "2026-01-01T00:00:00.000Z" }),
        buildOrder({ id: "2", orderedAt: "2026-01-01T00:00:01.000Z" }),
      ],
    });
    expect(latestRecordMs(base)).toBe(at("2026-01-01T00:00:01.000Z"));

    const canceled = buildState({
      orders: [
        buildOrder({
          id: "1",
          status: "CANCELED_UNFILLED",
          orderedAt: "2026-01-01T00:00:00.000Z",
          canceledAt: "2026-01-01T00:00:05.000Z",
        }),
      ],
    });
    expect(latestRecordMs(canceled)).toBe(at("2026-01-01T00:00:05.000Z"));

    const traded = buildState({
      orders: [buildOrder({ id: "1", orderedAt: "2026-01-01T00:00:00.000Z" })],
      trades: [buildTrade({ orderId: "1", executedAt: "2026-01-01T00:00:09.000Z" })],
    });
    expect(latestRecordMs(traded)).toBe(at("2026-01-01T00:00:09.000Z"));
  });

  // 決定 28 は `updatedAt` と `lastTickAt` を記録に含めない。含めると、`/_control/clock` の
  // `updatedAt`（実時刻）や時計そのものが下限になり、記録の無い区間へ戻せなくなる。
  it("updatedAt と lastTickAt は数えない", () => {
    const state = buildState({
      updatedAt: "2030-01-01T00:00:00.000Z",
      lastTickAt: "2030-01-01T00:00:00.000Z",
      orders: [
        buildOrder({
          id: "1",
          orderedAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2030-01-01T00:00:00.000Z",
        }),
      ],
    });
    expect(latestRecordMs(state)).toBe(at("2026-01-01T00:00:00.000Z"));
  });

  it("日付として解釈できない記録は飛ばす", () => {
    const state = buildState({
      orders: [
        buildOrder({ id: "1", orderedAt: "not-a-date" }),
        buildOrder({ id: "2", orderedAt: "2026-01-01T00:00:00.000Z" }),
      ],
      trades: [buildTrade({ orderId: "2", executedAt: "also-not-a-date" })],
    });
    expect(latestRecordMs(state)).toBe(at("2026-01-01T00:00:00.000Z"));
    expect(latestRecordMs(buildState({ orders: [buildOrder({ orderedAt: "x" })] }))).toBeNull();
  });
});

describe("persist", () => {
  it("save → load round trip preserves state", async () => {
    const state = buildState({ initialJpy: 42, balances: { jpy: 42 } });
    expect((await saveState(statePath, state)).success).toBe(true);
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toEqual(state);
  });

  it("load on missing file returns null", async () => {
    const r = await loadState(join(dir, "nope.json"));
    expect(r.success).toBe(true);
    if (r.success) expect(r.data).toBe(null);
  });

  it("migrates v1 → v3 on load", async () => {
    const v1 = {
      version: 1,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-06-01T00:00:00.000Z",
      initialJpy: 1_000_000,
      balances: { jpy: 1_000_000 },
      history: [],
    };
    writeFileSync(statePath, JSON.stringify(v1));
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(r.data.version).toBe(3);
    expect(r.data.lastTickAt).toBe(v1.updatedAt);
    expect(r.data.orders).toEqual([]);
    expect(r.data.trades).toEqual([]);
    expect(r.data.nextOrderSeq).toBe(1);
    expect(r.data.nextTradeSeq).toBe(1);
  });

  it("migrates v2 → v3: openOrders become UNFILLED, history becomes FULLY_FILLED + trades", async () => {
    const v2 = {
      version: 2,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-06-01T00:00:00.000Z",
      initialJpy: 1_000_000,
      balances: { jpy: 500_000, btc: 0.1 },
      lastTickAt: "2024-06-01T00:00:00.000Z",
      openOrders: [
        {
          id: "10",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          price: 5_000_000,
          amount: 0.01,
          createdAt: "2024-05-01T00:00:00.000Z",
        },
      ],
      history: [
        {
          id: "7",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.1,
          fillPrice: 4_000_000,
          feeJpy: 480,
          filledAt: "2024-04-01T00:00:00.000Z",
        },
        {
          id: "8",
          pair: "btc_jpy",
          side: "buy",
          type: "market",
          amount: 0.05,
          fillPrice: 4_100_000,
          feeJpy: 246,
          filledAt: "2024-04-02T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(statePath, JSON.stringify(v2));
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(r.data.version).toBe(3);
    const open = r.data.orders.find((o) => o.id === "10");
    const filled = r.data.orders.find((o) => o.id === "7");
    const market = r.data.orders.find((o) => o.id === "8");
    expect(open?.status).toBe("UNFILLED");
    expect(open?.orderedAt).toBe("2024-05-01T00:00:00.000Z");
    expect(filled?.status).toBe("FULLY_FILLED");
    expect(filled?.orderedAt).toBe("2024-04-01T00:00:00.000Z");
    expect(market?.price).toBeNull();
    expect(market?.executedNotional).toBeCloseTo(4_100_000 * 0.05, 6);
    expect(r.data.trades).toHaveLength(2);
    expect(r.data.trades[0]?.tradeId).toBe("1");
    expect(r.data.trades[0]?.orderId).toBe("7");
    expect(r.data.trades[1]?.orderId).toBe("8");
    expect(r.data.trades[1]?.makerTaker).toBe("taker");
    expect(r.data.nextOrderSeq).toBe(11);
    expect(r.data.nextTradeSeq).toBe(3);
  });

  it("migrates empty v2 and continues IDs from 1", async () => {
    const v2 = {
      version: 2,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      initialJpy: 1_000_000,
      balances: { jpy: 1_000_000 },
      lastTickAt: "2024-01-01T00:00:00.000Z",
      openOrders: [],
      history: [],
    };
    writeFileSync(statePath, JSON.stringify(v2));
    const r = await loadState(statePath);
    expect(r.success).toBe(true);
    if (!r.success || !r.data) throw new Error("unreachable");
    expect(r.data.nextOrderSeq).toBe(1);
    expect(r.data.nextTradeSeq).toBe(1);
    const placed = placeOrder(
      r.data,
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 5_000_000 },
      "2024-01-02T00:00:00.000Z",
      undefined,
      0,
    );
    expect(placed.success).toBe(true);
    if (placed.success) expect(placed.data.order.id).toBe("1");
  });

  it("continues order/trade IDs after v2 migration without colliding", async () => {
    const v2 = {
      version: 2,
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      initialJpy: 10_000_000,
      balances: { jpy: 10_000_000 },
      lastTickAt: "2024-01-01T00:00:00.000Z",
      openOrders: [
        {
          id: "1735689600001001",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          price: 5_000_000,
          amount: 0.001,
          createdAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      history: [
        {
          id: "9",
          pair: "btc_jpy",
          side: "buy",
          type: "limit",
          amount: 0.001,
          fillPrice: 4_000_000,
          feeJpy: 4.8,
          filledAt: "2023-12-01T00:00:00.000Z",
        },
      ],
    };
    writeFileSync(statePath, JSON.stringify(v2));
    const loaded = await loadState(statePath);
    expect(loaded.success).toBe(true);
    if (!loaded.success || !loaded.data) throw new Error("unreachable");
    const existing = new Set(loaded.data.orders.map((o) => o.id));
    const placed = placeOrder(
      loaded.data,
      { pair: "btc_jpy", side: "buy", type: "limit", amount: 0.001, price: 1_000_000 },
      "2024-01-02T00:00:00.000Z",
      undefined,
      0,
    );
    expect(placed.success).toBe(true);
    if (!placed.success) throw new Error("unreachable");
    expect(existing.has(placed.data.order.id)).toBe(false);
    expect(Number(placed.data.order.id)).toBeGreaterThan(1735689600001001);
    expect(placed.data.state.nextOrderSeq).toBe(Number(placed.data.order.id) + 1);
  });

  it("rejects malformed json with descriptive error", async () => {
    writeFileSync(statePath, "{ not valid");
    const r = await loadState(statePath);
    expect(r.success).toBe(false);
  });

  it("defaultStatePath honors BITBANK_MOCK_STATE_PATH override", () => {
    const orig = process.env.BITBANK_MOCK_STATE_PATH;
    process.env.BITBANK_MOCK_STATE_PATH = "/tmp/forced/state.json";
    try {
      expect(defaultStatePath("any-id")).toBe("/tmp/forced/state.json");
    } finally {
      if (orig === undefined) delete process.env.BITBANK_MOCK_STATE_PATH;
      else process.env.BITBANK_MOCK_STATE_PATH = orig;
    }
  });

  it("defaultStatePath uses BITBANK_MOCK_HOME + session id", () => {
    const origPath = process.env.BITBANK_MOCK_STATE_PATH;
    const origHome = process.env.BITBANK_MOCK_HOME;
    delete process.env.BITBANK_MOCK_STATE_PATH;
    process.env.BITBANK_MOCK_HOME = "/tmp/mock-home";
    try {
      expect(defaultStatePath("sess-1")).toBe("/tmp/mock-home/sessions/sess-1/state.json");
    } finally {
      if (origPath !== undefined) process.env.BITBANK_MOCK_STATE_PATH = origPath;
      if (origHome === undefined) delete process.env.BITBANK_MOCK_HOME;
      else process.env.BITBANK_MOCK_HOME = origHome;
    }
  });
});
