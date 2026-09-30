import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadState } from "../../src/engine/persist.ts";
import { activeOrders, type PaperState } from "../../src/engine/state.ts";
import type { FetchCandles } from "../../src/engine/types.ts";
import { loadOrInitDefault, SessionStore } from "../../src/store/session.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { buildTestServer, stubFetchCandles } from "../routes/helpers.ts";

// 重なった persist() が実際に 1 本にまとめられたかを見るため、saveState の
// 呼び出し回数を数える。中身は実物をそのまま呼ぶ。
//
// **数えるのは状態ファイルのパスごと**で、ひとつの共有カウンタにはしない。
// 共有カウンタだと、タイムアウトなどで打ち切られたテストの非同期処理があとから
// 書き込んだぶんまで数に入り、無関係なテストが落ちる（実際に CI で起きた）。
// パスはテストごとに別なので、分けておけば取りこぼしが混ざらない。
const saveStateCalls = vi.hoisted(() => ({ byPath: new Map<string, number>() }));
vi.mock("../../src/engine/persist.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/engine/persist.ts")>();
  return {
    ...actual,
    saveState: (...args: Parameters<typeof actual.saveState>) => {
      const [path] = args;
      saveStateCalls.byPath.set(path, (saveStateCalls.byPath.get(path) ?? 0) + 1);
      return actual.saveState(...args);
    },
  };
});

const T0 = Date.parse("2026-01-01T00:00:00.000Z");
const MIN = 60_000;

describe("SessionStore.tick", () => {
  it("fills active orders on every pair in one tick", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      orders: [
        buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
        buildOrder({ id: "2", pair: "eth_jpy", side: "buy", price: 100, startAmount: 1 }),
      ],
    });
    const store = new SessionStore(state, {
      path: null,
      fillMode: "market",
      fetchCandles: stubFetchCandles({
        btc_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
        eth_jpy: [candle(T0 + MIN, 110, 110, 50, 105)],
      }),
      feeRate: 0,
    });
    await store.tick(T0 + 2 * MIN);
    expect(activeOrders(store.state())).toHaveLength(0);
    expect(store.state().trades).toHaveLength(2);
  });

  it("does not fetch or fill in manual fillMode", async () => {
    let fetched = 0;
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "manual",
        fetchCandles: async () => {
          fetched += 1;
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toBe(0);
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // 状態ファイルのスキーマ（PaperStateSchema）は pair の文字種を見ないので、
  // 発注の検証より前に書かれた不正なペアの注文がそのまま読み込まれる。
  // そういう注文の分は外向きに問い合わせず、正常なペアの注文は今までどおり約定させる。
  it("skips malformed pairs loaded from a state file and still ticks valid ones", async () => {
    const fetched: string[] = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000, btc: 1 },
        orders: [
          buildOrder({
            id: "1",
            pair: "../../admin_jpy",
            side: "sell",
            price: 100,
            startAmount: 1,
          }),
          buildOrder({ id: "2", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
          buildOrder({ id: "3", pair: "btc\nevil_jpy", side: "sell", price: 100, startAmount: 1 }),
        ],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair) => {
          fetched.push(pair);
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toEqual(["btc_jpy"]);
    expect(activeOrders(store.state()).map((o) => o.pair)).toEqual([
      "../../admin_jpy",
      "btc\nevil_jpy",
    ]);
    // 生の pair はログへ出さない。改行を含むペアは JSON が \n へ逃がすので、
    // 警告 1 件がログの 2 行に割れることはない。
    expect(warnings).toEqual([
      'tick: skipping malformed pair "../../admin_jpy"',
      'tick: skipping malformed pair "btc\\nevil_jpy"',
    ]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字が出ていないことを見るのがこの検査の目的で、範囲指定そのものが意図である
    expect(warnings.every((w) => !/[\u0000-\u001f]/.test(w))).toBe(true);
  });

  // `/_control/tick` で進めた lastTickAt が実時刻より先にあると、取得範囲が
  // (未来, 現在) と逆転する。逆転した範囲では返った足が runTick の窓から全部外れて
  // 1 本も約定しないので、取得ごと飛ばして警告を出す（以前は黙って止まっていた）。
  it("skips the candle fetch and warns when lastTickAt is ahead of now", async () => {
    const fetched: Array<[string, number, number]> = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        // 時計が 5 時間先にある状態（control の tick で進めた後の形）。
        lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair, fromMs, toMs) => {
          fetched.push([pair, fromMs, toMs]);
          // 本来なら必ず約定する安い足。取得が走らないことを見たいので中身は関係ない。
          return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    // 逆転した範囲の問い合わせは走らない。
    expect(fetched).toEqual([]);
    expect(activeOrders(store.state())).toHaveLength(1);
    expect(warnings).toEqual([
      `tick: lastTickAt "${new Date(T0 + 5 * 60 * MIN).toISOString()}" is ahead of ` +
        `now "${new Date(T0 + 2 * MIN).toISOString()}"; skipping candle fetch`,
    ]);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字が出ていないことを見るのがこの検査の目的で、範囲指定そのものが意図である
    expect(warnings.every((w) => !/[\u0000-\u001f]/.test(w))).toBe(true);
  });

  // 戻した時計は状態ファイルにも残す。約定が 0 でも書かないと、再起動で未来の時計を
  // 読み直して同じ空振りを繰り返す。
  it("persists the recovered clock even though nothing filled", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bitbank-mock-clock-"));
    try {
      const path = join(dir, "state.json");
      const store = new SessionStore(
        buildState({
          lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
          balances: { jpy: 10_000_000 },
          orders: [
            buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 }),
          ],
        }),
        {
          path,
          fillMode: "market",
          feeRate: 0,
          fetchCandles: async () => ({ success: true, data: [] }),
        },
      );
      await store.tick(T0 + 2 * MIN);
      const reloaded = await loadState(path, {});
      expect(reloaded.success).toBe(true);
      expect(reloaded.success && reloaded.data?.lastTickAt).toBe(
        new Date(T0 + 2 * MIN).toISOString(),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // 時計が先にあっても、tick の最後で lastTickAt は実時刻に戻る（既存の挙動）。
  // だから警告が出るのはその 1 回だけで、次の tick は今までどおり取得して約定する。
  it("recovers on the next tick once lastTickAt is back to now", async () => {
    const fetched: Array<[string, number, number]> = [];
    const warnings: string[] = [];
    const store = new SessionStore(
      buildState({
        lastTickAt: new Date(T0 + 5 * 60 * MIN).toISOString(),
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        logger: { info: () => {}, warn: (m: string) => warnings.push(m) },
        fetchCandles: async (pair, fromMs, toMs) => {
          fetched.push([pair, fromMs, toMs]);
          return { success: true, data: [candle(T0 + 3 * MIN, 110, 110, 50, 105)] };
        },
      },
    );
    await store.tick(T0 + 2 * MIN);
    await store.tick(T0 + 4 * MIN);
    expect(fetched).toEqual([["btc_jpy", T0 + 2 * MIN, T0 + 4 * MIN]]);
    expect(activeOrders(store.state())).toHaveLength(0);
    expect(warnings).toHaveLength(1);
  });
});

describe("SessionStore.now", () => {
  it("既定は実時刻", () => {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    const before = Date.now();
    const now = store.now();
    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(Date.now());
  });

  // 既定の時計は `Date.now` の参照を作った時点で固定せず、呼ぶたびに読む。固定すると
  // store を作った後に `Date` だけを偽物にしたテストで、この時計だけが実時刻のまま残る。
  it("既定の時計は store を作った後に差し替えた Date にも従う", () => {
    const store = new SessionStore(buildState(), { path: null, fillMode: "manual" });
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(T0);
      expect(store.now()).toBe(T0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("渡した時計を呼ぶたびに読む", () => {
    let ms = T0;
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "manual",
      now: () => ms,
    });
    expect(store.now()).toBe(T0);
    ms = T0 + MIN;
    expect(store.now()).toBe(T0 + MIN);
  });

  it("tick() の既定の時刻は store の時計", async () => {
    const calls: Array<[number, number]> = [];
    const fetchCandles: FetchCandles = async (_pair, fromMs, toMs) => {
      calls.push([fromMs, toMs]);
      return { success: true, data: [candle(T0 + MIN, 110, 110, 50, 105)] };
    };
    const store = new SessionStore(
      buildState({
        lastTickAt: new Date(T0).toISOString(),
        orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
      }),
      { path: null, fillMode: "market", fetchCandles, feeRate: 0, now: () => T0 + 2 * MIN },
    );
    await store.tick();
    expect(calls).toEqual([[T0, T0 + 2 * MIN]]);
    expect(store.state().trades).toHaveLength(1);
    expect(store.state().lastTickAt).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  it("getLatestPrice() の既定の時刻は store の時計", async () => {
    const calls: Array<[number, number]> = [];
    const fetchCandles: FetchCandles = async (_pair, fromMs, toMs) => {
      calls.push([fromMs, toMs]);
      return { success: true, data: [candle(T0, 110, 110, 90, 105)] };
    };
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "manual",
      fetchCandles,
      now: () => T0 + MIN,
    });
    expect(await store.getLatestPrice("btc_jpy")).toBe(105);
    expect(calls).toEqual([[T0 + MIN - 5 * MIN, T0 + MIN]]);
  });
});

describe("SessionStore.persist", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-persist-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function readFileState(path: string) {
    const r = await loadState(path);
    if (!r.success) throw new Error(r.error);
    return r.data;
  }

  // 同一の状態ファイルへ並行に書くと、直列化が無いときは古いスナップショットの
  // rename が後から着地してメモリと食い違う。1 回では取りこぼすので複数回試す。
  it("並行発注の後でファイルがメモリと一致する", async () => {
    const TRIALS = 5;
    const ORDERS = 30;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const path = join(dir, `trial-${trial}`, "state.json");
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 100_000_000 } }),
        {},
        { path },
      );
      try {
        const responses = await Promise.all(
          Array.from({ length: ORDERS }, () =>
            fastify.inject({
              method: "POST",
              url: "/v1/user/spot/order",
              payload: {
                pair: "btc_jpy",
                side: "buy",
                type: "limit",
                price: 5_000_000,
                amount: 0.001,
              },
            }),
          ),
        );
        for (const res of responses) expect(res.json().success).toBe(1);

        const memory = store.state();
        expect(memory.orders).toHaveLength(ORDERS);
        expect(memory.nextOrderSeq).toBe(ORDERS + 1);

        const onDisk = await readFileState(path);
        expect({
          trial,
          orders: onDisk?.orders.length,
          nextOrderSeq: onDisk?.nextOrderSeq,
        }).toEqual({ trial, orders: ORDERS, nextOrderSeq: ORDERS + 1 });
        expect(onDisk).toEqual(memory);
      } finally {
        await close();
      }
    }
  });

  // 発注だけの並行より経路が広い（取消は cancelOrder、部分約定は control 経由の fillOrder）。
  // どれも store.replace() → store.persist() の順に走るので、直列化が崩れると
  // 約定済みの注文が UNFILLED のままのファイルに巻き戻る。1 回では取りこぼすので複数回試す。
  it("発注・取消・部分約定を混ぜた同時実行の後でファイルがメモリと一致する", async () => {
    const TRIALS = 5;
    for (let trial = 0; trial < TRIALS; trial += 1) {
      const path = join(dir, `mixed-${trial}`, "state.json");
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 1_000_000_000 } }),
        {},
        { path, fillMode: "manual", controlEnabled: true },
      );
      try {
        const place = () =>
          fastify.inject({
            method: "POST",
            url: "/v1/user/spot/order",
            payload: {
              pair: "btc_jpy",
              side: "buy",
              type: "limit",
              price: 5_000_000,
              amount: 0.002,
            },
          });
        // 種の注文を直列に 30 本（id 1..30）置いてから、同時実行を始める。
        for (let i = 0; i < 30; i += 1) expect((await place()).json().success).toBe(1);

        const jobs: Promise<unknown>[] = [];
        for (let i = 0; i < 10; i += 1) jobs.push(place()); // 新規発注（id 31..40）
        for (let i = 1; i <= 10; i += 1) {
          jobs.push(
            fastify.inject({
              method: "POST",
              url: "/v1/user/spot/cancel_order",
              payload: { pair: "btc_jpy", order_id: i },
            }),
          );
        }
        for (let i = 11; i <= 20; i += 1) {
          // 0.002 のうち 0.001 だけ約定させて PARTIALLY_FILLED にする。
          jobs.push(
            fastify.inject({
              method: "POST",
              url: `/_control/orders/${i}/fill`,
              payload: { amount: 0.001 },
            }),
          );
        }
        for (let i = 21; i <= 30; i += 1) {
          jobs.push(fastify.inject({ method: "POST", url: `/_control/orders/${i}/fill` }));
        }
        const responses = (await Promise.all(jobs)) as Array<{ statusCode: number }>;
        expect(responses.filter((r) => r.statusCode >= 400)).toEqual([]);

        const memory = store.state();
        expect(memory.orders).toHaveLength(40);

        // 状態ファイルを読み直して、全注文の status / 約定量 / trade を突き合わせる。
        const onDisk = await readFileState(path);
        const shape = (s: PaperState) => ({
          nextOrderSeq: s.nextOrderSeq,
          nextTradeSeq: s.nextTradeSeq,
          balances: s.balances,
          orders: s.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional]),
          trades: s.trades.map((t) => [t.tradeId, t.orderId, t.amount]),
        });
        expect({ trial, ...shape(onDisk!) }).toEqual({ trial, ...shape(memory) });
        expect(onDisk).toEqual(memory);
      } finally {
        await close();
      }
    }
    // 5 試行それぞれでサーバを立て、並行に発注・取消・約定させて実ファイルへ書く。
    // 既定の 5000ms では負荷の高い runner で足りず、CI で落ちた。
  }, 30_000);

  // 2xx だけでは書き込みの成否を判定できないので、失敗を store が覚える。
  // 状態ファイルのパスをディレクトリにすると rename が必ず EISDIR で落ちる。
  describe("書き出しの失敗の記録", () => {
    it("成功しかしていなければ初期値のまま", async () => {
      const path = join(dir, "health-ok", "state.json");
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      await store.persist();
      expect(store.persistHealth()).toEqual({ lastError: null, consecutiveFailures: 0 });
    });

    it("失敗のたびに連続失敗数が増え、直近の失敗を覚える", async () => {
      const path = join(dir, "health-ng", "state.json");
      await mkdir(path, { recursive: true }); // ここをディレクトリにすると rename が落ちる
      const warnings: string[] = [];
      const store = new SessionStore(buildState(), {
        path,
        fillMode: "manual",
        logger: { warn: (m) => warnings.push(m), info: () => {} },
      });

      await store.persist();
      const first = store.persistHealth();
      expect(first.consecutiveFailures).toBe(1);
      expect(first.lastError?.message).toContain("EISDIR");
      expect(Date.parse(first.lastError!.at)).not.toBeNaN();

      store.replace(buildState({ nextOrderSeq: 2 }));
      await store.persist();
      expect(store.persistHealth().consecutiveFailures).toBe(2);
      expect(warnings).toHaveLength(2);
    });

    it("書き込みが成功すると連続失敗数は 0 に戻るが、直近の失敗は残る", async () => {
      const path = join(dir, "health-recover", "state.json");
      await mkdir(path, { recursive: true });
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      await store.persist();
      expect(store.persistHealth().consecutiveFailures).toBe(1);

      // ディレクトリを退けると書けるようになる。
      await rm(path, { recursive: true });
      store.replace(buildState({ nextOrderSeq: 2 }));
      await store.persist();

      const health = store.persistHealth();
      expect(health.consecutiveFailures).toBe(0);
      // 一度でも失敗したことは消さない（その実験の記録は疑ってかかる必要がある）。
      expect(health.lastError?.message).toContain("EISDIR");
    });

    // 閉じた標準出力への console.warn は EPIPE で投げる。ここで投げ返すと、発注が
    // メモリ上では成立しているのにルートが封筒でない 500 を返し、クライアントの再送が
    // 二重注文になる。書き込みが失敗しても 2xx を返すのがここの約束。
    // 失敗の時刻は診断用なので、store の時計（`now()`）ではなく実時刻で記録する。
    // 時計を実時刻から大きく離しておき、どちらで記録したかを見分ける。
    it("失敗の時刻は store の時計ではなく実時刻で記録する", async () => {
      const path = join(dir, "health-clock", "state.json");
      await mkdir(path, { recursive: true });
      const store = new SessionStore(buildState(), { path, fillMode: "manual", now: () => T0 });
      const before = Date.now();
      await store.persist();
      const at = Date.parse(store.persistHealth().lastError!.at);
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(Date.now());
    });

    it("logger が投げても persist は解決し、失敗は記録されている", async () => {
      const path = join(dir, "health-throw", "state.json");
      await mkdir(path, { recursive: true });
      const store = new SessionStore(buildState(), {
        path,
        fillMode: "manual",
        logger: {
          warn: () => {
            throw new Error("logger が壊れている");
          },
          info: () => {},
        },
      });

      await expect(store.persist()).resolves.toBeUndefined();
      expect(store.persistHealth().consecutiveFailures).toBe(1);
      expect(store.persistHealth().lastError?.message).toContain("EISDIR");
    });

    // 指摘の本質は応答が壊れること。ルート越しに固定する。
    // 既定の degrade では中身が「断り」の封筒になるが、封筒であること自体が要点。
    // 劣化の中身そのものは tests/server/degraded.test.ts で見る。
    it("logger が投げても互換ルートは封筒を返す（生の 500 にならない）", async () => {
      const path = join(dir, "health-route", "state.json");
      await mkdir(path, { recursive: true });
      const { fastify, store, close } = await buildTestServer(
        buildState({ balances: { jpy: 100_000_000 } }),
        {},
        {
          path,
          fillMode: "manual",
          logger: {
            warn: () => {
              throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
            },
            info: () => {},
          },
        },
      );
      try {
        const res = await fastify.inject({
          method: "POST",
          url: "/v1/user/spot/order",
          payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.001 },
        });
        // 封筒でない 500（`{"statusCode":500,"code":"EPIPE",...}`）が返ってはいけない。
        expect(res.statusCode).toBe(200);
        expect(res.json()).toHaveProperty("success");
        expect(res.json()).not.toHaveProperty("statusCode");
        // 既定は degrade なので、書き込みに失敗したこの要求自体が断られる。
        expect(res.json()).toEqual({ success: 0, data: { code: 70001 } });
        // 巻き戻さないので注文はメモリに残る。書けていないことは control から分かる。
        expect(store.state().orders).toHaveLength(1);
        expect(store.persistHealth().consecutiveFailures).toBe(1);
      } finally {
        await close();
      }
    });

    // fs のエラーは対象のパスを生のまま含み、パスは BITBANK_MOCK_STATE_PATH 由来。
    it("改行を含むパスでも警告が 1 行に収まる", async () => {
      const evil = join(dir, "a\n2026-01-01 FAKE LOG LINE", "state.json");
      await mkdir(evil, { recursive: true });
      const warnings: string[] = [];
      const store = new SessionStore(buildState(), {
        path: evil,
        fillMode: "manual",
        logger: { warn: (m) => warnings.push(m), info: () => {} },
      });

      await store.persist();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]!.split("\n")).toHaveLength(1);
      expect(warnings[0]).toContain("FAKE LOG LINE");
    });
  });

  it("重なった persist() は 1 本にまとめるが最後の 1 本は必ず着地する", async () => {
    for (let trial = 0; trial < 5; trial += 1) {
      const path = join(dir, `coalesce-${trial}`, "state.json");
      const store = new SessionStore(buildState(), { path, fillMode: "manual" });
      const waits: Promise<void>[] = [];
      for (let i = 1; i <= 20; i += 1) {
        store.replace(
          buildState({
            nextOrderSeq: i,
            updatedAt: `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`,
          }),
        );
        waits.push(store.persist());
      }
      await Promise.all(waits);
      // 20 本の persist() が 1 本の書き込みにまとまる（途中の 19 本は捨てる）。
      expect(saveStateCalls.byPath.get(path) ?? 0).toBe(1);
      expect(await readFileState(path)).toEqual(store.state());
    }
  });

  // 発注 → 部分約定 → 取消 の系列を書き出し、読み直した store と突き合わせる。
  it("発注・部分約定・取消の後、読み直した状態が一致する", async () => {
    const path = join(dir, "restart", "state.json");
    const { fastify, store, close } = await buildTestServer(
      buildState({ balances: { jpy: 100_000_000 } }),
      {},
      { path, fillMode: "manual", controlEnabled: true },
    );
    let before: PaperState;
    try {
      const created = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/order",
        payload: { pair: "btc_jpy", side: "buy", type: "limit", price: 5_000_000, amount: 0.004 },
      });
      const orderId = String(created.json().data.order_id);

      const filled = await fastify.inject({
        method: "POST",
        url: `/_control/orders/${orderId}/fill`,
        payload: { amount: 0.001 },
      });
      expect(filled.statusCode).toBe(200);

      const canceled = await fastify.inject({
        method: "POST",
        url: "/v1/user/spot/cancel_order",
        payload: { pair: "btc_jpy", order_id: Number(orderId) },
      });
      expect(canceled.json().data.status).toBe("CANCELED_PARTIALLY_FILLED");
      before = store.state();
    } finally {
      await close();
    }

    // 再起動を模して store を作り直す。
    const reloaded = await loadOrInitDefault(1_000_000, { path, fillMode: "manual" });
    const after = reloaded.state();
    expect(after).toEqual(before);
    expect(after.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional])).toEqual(
      before.orders.map((o) => [o.id, o.status, o.executedAmount, o.executedNotional]),
    );
    expect(after.trades).toEqual(before.trades);
    expect(after.orders[0]?.status).toBe("CANCELED_PARTIALLY_FILLED");
    expect(after.orders[0]?.executedAmount).toBe(0.001);
    expect(after.trades).toHaveLength(1);
  });
});

/**
 * 足の取得の健全性（`candlesHealth()` / `GET /_control/state` の `candles`）。
 *
 * 市場モードで取得に失敗しても、`tick()` は warn に落として先へ進み、`lastTickAt` は
 * そのまま現在時刻へ進む。互換ルートは成功応答を返し続けるので、**失敗はどこにも出ない**。
 * ここが唯一の出口なので、`persist` の記録と同じ強さで固定する。
 */
describe("SessionStore の足の取得の健全性", () => {
  /** 取得先の URL をそのまま含む、`fetchOneDay()` が返す形の失敗。 */
  const fetchError = (pair: string) =>
    `candles HTTP 500 for http://127.0.0.1:9/${pair}/candlestick/1min/20260101`;

  /** どのペアでも必ず失敗する取得。`fetchOneDay()` が返す形の理由を載せる。 */
  const failingFetch = (): FetchCandles => async (pair) => ({
    success: false,
    error: fetchError(pair),
  });

  /**
   * `btc_jpy` の active な注文を 1 本だけ持つ store。**market では tick() が取りに行く
   * ペアが 1 つある**状態を作るためのもので、`fillMode` と取得の実装だけを入れ替える。
   */
  function storeWithOrder(opts: {
    fetchCandles: FetchCandles;
    fillMode?: "manual" | "market";
    warnings?: string[];
  }) {
    return new SessionStore(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {
        path: null,
        fillMode: opts.fillMode ?? "market",
        feeRate: 0,
        fetchCandles: opts.fetchCandles,
        logger: opts.warnings
          ? { info: () => {}, warn: (m: string) => opts.warnings?.push(m) }
          : undefined,
      },
    );
  }

  // 一度も取りに行っていない状態が「失敗なし」を表す。active な注文が無ければ market でも
  // 取得は起きないので、これは manual と同じ形になる（だから fillMode を添えてある）。
  it("一度も取りに行っていなければ失敗なしを表す", async () => {
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "market",
      fetchCandles: stubFetchCandles({}),
    });
    await store.tick(T0 + MIN);
    expect(store.candlesHealth()).toEqual({
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      fillMode: "market",
    });
  });

  // manual では tick() が取りに行かない。初期値は「取りに行って何も起きていない」ではなく
  // 「取りに行っていない」ことを表すので、読み分けられるよう fillMode を同じ形に入れてある。
  it("manual では取得が起きず、fillMode でそれと読み分けられる", async () => {
    let fetched = 0;
    const store = storeWithOrder({
      fillMode: "manual",
      fetchCandles: async () => {
        fetched += 1;
        return { success: true, data: [] };
      },
    });
    await store.tick(T0 + 2 * MIN);
    expect(fetched).toBe(0);
    expect(store.candlesHealth()).toEqual({
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: null,
      fillMode: "manual",
    });
  });

  // 「いつまでは足が取れていたか」。lastTickAt と同じ時計で記録するので並べて読める。
  it("取得に成功すると lastSuccessAt が tick の時計で入る", async () => {
    const store = storeWithOrder({
      fetchCandles: stubFetchCandles({ btc_jpy: [candle(T0 + MIN, 110, 110, 50, 105)] }),
    });
    await store.tick(T0 + 2 * MIN);
    const health = store.candlesHealth();
    expect(health.lastSuccessAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(health.lastSuccessAt).toBe(store.state().lastTickAt);
    expect(health.lastError).toBeNull();
    expect(health.consecutiveFailures).toBe(0);
  });

  it("失敗のたびに連続失敗数が増え、直近の失敗を覚える", async () => {
    const store = storeWithOrder({ fetchCandles: failingFetch() });

    await store.tick(T0 + 2 * MIN);
    const first = store.candlesHealth();
    expect(first.consecutiveFailures).toBe(1);
    expect(first.lastError?.message).toBe(fetchError("btc_jpy"));
    expect(first.lastError?.at).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(first.lastSuccessAt).toBeNull();

    await store.tick(T0 + 3 * MIN);
    expect(store.candlesHealth().consecutiveFailures).toBe(2);
    expect(store.candlesHealth().lastError?.at).toBe(new Date(T0 + 3 * MIN).toISOString());
  });

  it("取得に成功すると連続失敗数は 0 に戻るが、直近の失敗は残る", async () => {
    let failing = true;
    const store = storeWithOrder({
      fetchCandles: async (pair, fromMs, toMs) => {
        if (failing) return { success: false, error: fetchError(pair) };
        return stubFetchCandles({ btc_jpy: [candle(T0 + MIN, 110, 110, 109, 110)] })(
          pair,
          fromMs,
          toMs,
        );
      },
    });
    await store.tick(T0 + 2 * MIN);
    expect(store.candlesHealth().consecutiveFailures).toBe(1);

    failing = false;
    await store.tick(T0 + 3 * MIN);

    const health = store.candlesHealth();
    expect(health.consecutiveFailures).toBe(0);
    // 一度でも失敗したことは消さない（persist と同じ。その窓の足は取り直さないので、
    // 取れていない区間があったことは実験の解釈に効く）。
    expect(health.lastError?.message).toBe(fetchError("btc_jpy"));
    expect(health.lastError?.at).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(health.lastSuccessAt).toBe(new Date(T0 + 3 * MIN).toISOString());
  });

  // **取得失敗時の挙動は変えていない。** warn に落として continue し、lastTickAt は
  // 無条件に進む（失敗した窓は二度と取りに行かない）。見えるようにしただけであることを固定する。
  it("失敗しても tick は進み、失敗した窓は取り直さない", async () => {
    const fetched: Array<[number, number]> = [];
    const store = storeWithOrder({
      fetchCandles: async (pair, fromMs, toMs) => {
        fetched.push([fromMs, toMs]);
        return { success: false, error: fetchError(pair) };
      },
    });
    await store.tick(T0 + 2 * MIN);
    expect(store.state().lastTickAt).toBe(new Date(T0 + 2 * MIN).toISOString());
    await store.tick(T0 + 3 * MIN);
    // 2 回目の起点は 1 回目の終端。失敗した窓 (T0, T0+2MIN) は取り直さない。
    expect(fetched).toEqual([
      [T0, T0 + 2 * MIN],
      [T0 + 2 * MIN, T0 + 3 * MIN],
    ]);
    expect(activeOrders(store.state())).toHaveLength(1);
  });

  // 失敗の理由には取得先の URL が入り、URL には BITBANK_PUBLIC_BASE_URL 由来の値が入る。
  // ログへ出すときは JSON で包む（docs/fidelity.md の「ログに出す利用者由来の値」）。
  it("改行を含む失敗でも警告が 1 行に収まる", async () => {
    const warnings: string[] = [];
    const store = storeWithOrder({
      warnings,
      fetchCandles: async () => ({
        success: false,
        error: "candles HTTP 500 for http://evil/\n2026-01-01 FAKE LOG LINE",
      }),
    });
    await store.tick(T0 + 2 * MIN);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]!.split("\n")).toHaveLength(1);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: 制御文字が出ていないことを見るのがこの検査の目的で、範囲指定そのものが意図である
    expect(/[\u0000-\u001f]/.test(warnings[0]!)).toBe(false);
    // health のほうは包み直さない。応答は JSON なのでシリアライザが同じ仕事をする。
    expect(store.candlesHealth().lastError?.message).toContain("\n");
  });

  // 成行の発注が使う経路。fillMode が manual でもここは取りに行くので、記録も動く。
  it("getLatestPrice の失敗も同じ health に記録する", async () => {
    const store = storeWithOrder({ fillMode: "manual", fetchCandles: failingFetch() });
    expect(await store.getLatestPrice("btc_jpy", T0 + 2 * MIN)).toBeNull();
    expect(store.candlesHealth()).toEqual({
      lastError: {
        at: new Date(T0 + 2 * MIN).toISOString(),
        message: fetchError("btc_jpy"),
      },
      consecutiveFailures: 1,
      lastSuccessAt: null,
      fillMode: "manual",
    });
  });

  // 空振り（窓に足が 1 本も無い）は取得の失敗ではない。getLatestPrice は同じ null を
  // 返すが、health には成功として残る——利用側はこれで 70001 の理由を見分ける。
  it("窓が空なだけのときは失敗として記録しない", async () => {
    const store = storeWithOrder({ fetchCandles: stubFetchCandles({}) });
    expect(await store.getLatestPrice("btc_jpy", T0 + 2 * MIN)).toBeNull();
    const health = store.candlesHealth();
    expect(health.lastError).toBeNull();
    expect(health.lastSuccessAt).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  // ペアごとに分けず 1 つに持つことの代償。片方のペアだけ失敗し続けていても、もう片方の
  // 成功で連続失敗数は 0 に戻る。lastError は消さないので「一度でも失敗したか」は残る。
  it("片方のペアだけ失敗しているとき連続失敗数は 0 に戻る（1 つに持つ代償）", async () => {
    const store = new SessionStore(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [
          buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 1, startAmount: 1 }),
          buildOrder({ id: "2", pair: "eth_jpy", side: "buy", price: 1, startAmount: 1 }),
        ],
      }),
      {
        path: null,
        fillMode: "market",
        feeRate: 0,
        fetchCandles: async (pair) =>
          pair === "btc_jpy"
            ? { success: false, error: fetchError(pair) }
            : { success: true, data: [] },
      },
    );
    await store.tick(T0 + 2 * MIN);
    const health = store.candlesHealth();
    expect(health.consecutiveFailures).toBe(0);
    expect(health.lastError?.message).toBe(fetchError("btc_jpy"));
  });

  /**
   * 取得を止めたまま返す store。`release` に窓の終端ごとの解決関数が入るので、
   * **完了の順を呼び出し側で決められる**（並行した取得が順不同に着く筋を組み立てる）。
   */
  function gatedStore(outcome: (toMs: number) => Awaited<ReturnType<FetchCandles>>) {
    const release = new Map<number, () => void>();
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "manual",
      fetchCandles: (_pair, _fromMs, toMs) =>
        new Promise((resolve) => {
          release.set(toMs, () => resolve(outcome(toMs)));
        }),
    });
    return { store, release };
  }

  // 互換ルートは並行に叩かれるので、取得も開始の順に完了するとは限らない。素直に上書き
  // すると「いつまで足が取れていたか」が実際より手前に見える。
  it("後から完了した古い取得が lastSuccessAt を巻き戻さない", async () => {
    const { store, release } = gatedStore(() => ({ success: true, data: [] }));
    const older = store.getLatestPrice("btc_jpy", T0 + MIN);
    const newer = store.getLatestPrice("btc_jpy", T0 + 2 * MIN);

    // 後から始めた新しいほうを先に完了させる。
    release.get(T0 + 2 * MIN)?.();
    await newer;
    expect(store.candlesHealth().lastSuccessAt).toBe(new Date(T0 + 2 * MIN).toISOString());

    release.get(T0 + MIN)?.();
    await older;
    expect(store.candlesHealth().lastSuccessAt).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  // 同じことを失敗の側でも見る。ただし**連続失敗数は完了した順に数える**（新しいほうが
  // 先に完了したら古い失敗を捨てる形にすると、lastError が null のままになる経路ができる）。
  it("後から完了した古い失敗が lastError を塗り替えないが、連続失敗数には数える", async () => {
    const { store, release } = gatedStore((toMs) => ({
      success: false,
      error: `candles HTTP 500 at ${toMs}`,
    }));
    const older = store.getLatestPrice("btc_jpy", T0 + MIN);
    const newer = store.getLatestPrice("btc_jpy", T0 + 2 * MIN);

    release.get(T0 + 2 * MIN)?.();
    await newer;
    release.get(T0 + MIN)?.();
    await older;

    const health = store.candlesHealth();
    expect(health.lastError?.at).toBe(new Date(T0 + 2 * MIN).toISOString());
    expect(health.lastError?.message).toBe(`candles HTTP 500 at ${T0 + 2 * MIN}`);
    expect(health.consecutiveFailures).toBe(2);
  });

  // 失敗を互換ルートの応答へ漏らさない（実 API に無い情報であり、封筒の契約を壊す）。
  // 見る口は `GET /_control/state` の `candles` だけである。
  it("取得に失敗しても互換ルートは成功応答のままで、control にだけ失敗が出る", async () => {
    const { fastify, close } = await buildTestServer(
      buildState({
        balances: { jpy: 10_000_000 },
        orders: [buildOrder({ id: "1", pair: "btc_jpy", side: "buy", price: 100, startAmount: 1 })],
      }),
      {},
      {
        path: null,
        fillMode: "market",
        controlEnabled: true,
        fetchCandles: failingFetch(),
      },
    );
    try {
      const active = await fastify.inject({
        method: "GET",
        url: "/v1/user/spot/active_orders?pair=btc_jpy",
      });
      expect(active.statusCode).toBe(200);
      expect(active.json().success).toBe(1);
      expect(active.json().data.orders).toHaveLength(1);
      expect(active.json()).not.toHaveProperty("candles");

      const state = await fastify.inject({ method: "GET", url: "/_control/state" });
      expect(state.json().candles.consecutiveFailures).toBe(1);
      expect(state.json().candles.lastError.message).toBe(fetchError("btc_jpy"));
    } finally {
      await close();
    }
  });
});

describe("SessionStore の状態の差し替えの通知", () => {
  const manualStore = (state: PaperState = buildState()) =>
    new SessionStore(state, { path: null, fillMode: "manual", fetchCandles: stubFetchCandles({}) });

  it("replace は差し替えの直前と直後を update として渡し、外した購読者には渡さない", () => {
    const store = manualStore();
    const seen: Array<{ prevOrders: number; nextOrders: number; kind: string }> = [];
    const off = store.onStateChange(({ prev, next, kind }) => {
      seen.push({ prevOrders: prev.orders.length, nextOrders: next.orders.length, kind });
    });
    store.replace(buildState({ orders: [buildOrder()] }));
    off();
    store.replace(buildState());
    expect(seen).toEqual([{ prevOrders: 0, nextOrders: 1, kind: "update" }]);
  });

  it("同じ状態を渡し直しただけなら通知しない", () => {
    const state = buildState();
    const store = manualStore(state);
    const listener = vi.fn();
    store.onStateChange(listener);
    store.replace(state);
    expect(listener).not.toHaveBeenCalled();
  });

  it("commit は書き出しを待たず、メモリへ反映した直後に通知する", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bitbank-mock-notify-"));
    try {
      const store = new SessionStore(buildState(), {
        path: join(dir, "state.json"),
        fillMode: "manual",
        fetchCandles: stubFetchCandles({}),
      });
      const listener = vi.fn();
      store.onStateChange(listener);
      const pending = store.commit(buildState({ orders: [buildOrder()] }));
      // まだ書き出しは終わっていないが、通知は済んでいる（stream が HTTP 応答より先に届き得る理由）。
      expect(listener).toHaveBeenCalledTimes(1);
      await pending;
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reset は kind を reset にして渡す", async () => {
    const store = manualStore(buildState({ orders: [buildOrder()] }));
    const kinds: string[] = [];
    store.onStateChange(({ kind }) => kinds.push(kind));
    await store.reset(buildState());
    expect(kinds).toEqual(["reset"]);
    expect(store.state().orders).toEqual([]);
  });

  it("market の tick が埋めた約定も通知に載る（commit を通らない経路）", async () => {
    const state = buildState({
      balances: { jpy: 10_000_000 },
      lastTickAt: new Date(T0).toISOString(),
      orders: [buildOrder({ id: "1", side: "buy", price: 100, startAmount: 1 })],
    });
    const store = new SessionStore(state, {
      path: null,
      fillMode: "market",
      fetchCandles: stubFetchCandles({ btc_jpy: [candle(T0 + MIN, 110, 110, 50, 105)] }),
      feeRate: 0,
    });
    const changes: Array<{ trades: number; lastTickAt: string }> = [];
    store.onStateChange(({ next }) =>
      changes.push({ trades: next.trades.length, lastTickAt: next.lastTickAt }),
    );
    await store.tick(T0 + 2 * MIN);
    // 約定 1 回と、時計の前進 1 回。どちらも同じ口を通る。
    expect(changes.map((c) => c.trades)).toEqual([1, 1]);
    expect(changes.at(-1)?.lastTickAt).toBe(new Date(T0 + 2 * MIN).toISOString());
  });

  it("購読者が投げても差し替えは止まらず、後ろの購読者にも届く", () => {
    const warnings: string[] = [];
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "manual",
      fetchCandles: stubFetchCandles({}),
      logger: { warn: (m) => warnings.push(m), info: () => {} },
    });
    const after = vi.fn();
    store.onStateChange(() => {
      throw new Error("boom\nsecond line");
    });
    store.onStateChange(after);
    const next = buildState({ orders: [buildOrder()] });
    store.replace(next);
    expect(store.state()).toBe(next);
    expect(after).toHaveBeenCalledTimes(1);
    // 理由は JSON で包んで 1 行に収める。
    expect(warnings).toEqual(['state listener failed: "boom\\nsecond line"']);
  });

  it("購読者が投げ、さらに warn まで投げても差し替えは止まらない", () => {
    const store = new SessionStore(buildState(), {
      path: null,
      fillMode: "manual",
      fetchCandles: stubFetchCandles({}),
      logger: {
        warn: () => {
          throw new Error("EPIPE");
        },
        info: () => {},
      },
    });
    store.onStateChange(() => {
      throw "not an Error";
    });
    const next = buildState({ orders: [buildOrder()] });
    expect(() => store.replace(next)).not.toThrow();
    expect(store.state()).toBe(next);
  });
});
