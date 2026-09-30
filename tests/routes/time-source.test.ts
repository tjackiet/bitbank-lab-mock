import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import type { Candle } from "../../src/engine/candles.ts";
import { buildOrder, buildState, candle } from "../engine/helpers.ts";
import { setupBuildTestServer } from "./helpers.ts";

/**
 * `src/routes/` が記録する時刻を `SessionStore.now()` から読むことを固定する
 * （`docs/plan-lab-mock.md` 17.3 の PR C1）。
 *
 * 仮想時計（PR C2）は `store.now()` の中身だけを差し替える。ルートが `Date.now()` や
 * `new Date()` で実時刻を直に読むと、**その経路だけが黙って実時刻のまま記録される。**
 * 塞ぎたいのは「新しいルートを足した人が `new Date()` と書く」ことなので、2 方向から見る。
 *
 * 1. 静的: `src/routes/` のソースを構文木で読み、実時刻を読む式が許可リストの外に無いこと
 * 2. 動的: store に固定の時計を渡し、ルートが記録する時刻がその時計の値になること
 *
 * 静的な検査は**ルートの一覧を手書きしない**（`src/routes/` のファイルを全部読む）。
 * 手書きにすると、塞ごうとしている書き忘れがテスト側で起きる（`tests/routes/tick.test.ts` と
 * 同じ考え方）。
 */

const ROUTES_DIR = "src/routes";

/**
 * 実時刻を読む式として数える形。
 *
 * - `Date.now`（呼び出しでも、関数として渡すだけでも）
 * - 引数の無い `new Date()` / `new Date`
 * - `Date()`（現在時刻の文字列を返す）
 * - `nowIso()`（`src/engine/state.ts`。実時刻の ISO 文字列）
 *
 * **数えないもの:** 引数のある `new Date(x)` と `Date.parse(x)` は変換で、時刻の出どころでは
 * ない。`freshState()` は中で実時刻を読むが、reset で時計は実時刻に戻ると決めてあるので
 * （`docs/plan-lab-mock.md` 17.2 の決定 25）数えない。
 */
function realClockForm(node: ts.Node): string | null {
  if (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    node.name.text === "now"
  ) {
    return "Date.now";
  }
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "Date" &&
    (node.arguments?.length ?? 0) === 0
  ) {
    return "new Date()";
  }
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    if (node.expression.text === "Date") return "Date()";
    if (node.expression.text === "nowIso") return "nowIso()";
  }
  return null;
}

const HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete"]);

/** 式を囲むルートの登録（`fastify.post("/tick", ...)` なら `POST /tick`）。無ければ `null`。 */
function enclosingRoute(node: ts.Node): string | null {
  for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
    if (!ts.isCallExpression(n) || !ts.isPropertyAccessExpression(n.expression)) continue;
    const method = n.expression.name.text;
    const [path] = n.arguments;
    if (HTTP_METHODS.has(method) && path && ts.isStringLiteral(path)) {
      return `${method.toUpperCase()} ${path.text}`;
    }
  }
  return null;
}

/**
 * 式がそのまま初期値になっている変数の名前（`const realNowMs = Date.now();` なら `realNowMs`）。
 * 別の式の途中で使っているなら `null`。
 */
function boundName(node: ts.Node): string | null {
  let expr: ts.Node = node;
  // `Date.now` は呼び出しの callee なので、呼び出し式まで上がってから見る。
  if (ts.isCallExpression(expr.parent) && expr.parent.expression === expr) expr = expr.parent;
  const decl = expr.parent;
  if (ts.isVariableDeclaration(decl) && decl.initializer === expr && ts.isIdentifier(decl.name)) {
    return decl.name.text;
  }
  return null;
}

type RealClockRead = {
  /** `src/routes/` からの相対パス。 */
  file: string;
  line: number;
  form: string;
  /** 許可リストの鍵。`ファイル ルート 変数名`（ルートや変数に入っていなければ `-`）。 */
  key: string;
};

function realClockReads(file: string, text: string): RealClockRead[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: RealClockRead[] = [];
  const visit = (node: ts.Node) => {
    const form = realClockForm(node);
    if (form !== null) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
      const key = `${file} ${enclosingRoute(node) ?? "-"} ${boundName(node) ?? "-"}`;
      found.push({ file, line, form, key });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** `src/routes/` 配下の `.ts`。論理パスは常に `/` で組む（`tests/structure.test.ts` と同じ）。 */
const routeFiles = readdirSync(ROUTES_DIR, { recursive: true, encoding: "utf8" })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => f.endsWith(".ts"))
  .sort();

const reads = routeFiles.flatMap((f) =>
  realClockReads(f, readFileSync(join(ROUTES_DIR, f), "utf8")),
);

/**
 * **`src/routes/` で実時刻を直に読んでよい箇所と、その理由。** 鍵は `ファイル ルート 変数名`。
 *
 * 2 つとも `/_control/` の時計の上限の判定で、上限は「実時刻から 24 時間」と決めてある
 * （`src/routes/control.ts` の `MAX_CLOCK_AHEAD_MS`）。記録する時刻の出どころ
 * （`store.now()`）とは別の基準なので、時計そのものからは測らない。
 *
 * 許可リストは緩めるためではなく、例外を 1 か所に集めて古くならせないために持つ。
 * 載せた箇所が無くなればエントリを外すまで落ちる（`tests/structure.test.ts` と同じ考え方）。
 */
const ALLOWED_REAL_CLOCK_READS: Record<string, string> = {
  "control.ts POST /tick realNowMs":
    "`POST /_control/tick` の上限（実時刻 + `MAX_CLOCK_AHEAD_MS`）の基準。60 秒の前進と" +
    "足の `timestamp` の両方をこの上限と比べる",
  "control.ts POST /clock realNowMs":
    "`POST /_control/clock` の上限（実時刻 + `MAX_CLOCK_AHEAD_MS`）の基準",
};

describe("src/routes/ は時刻を store.now() から読む（静的）", () => {
  it("検出が空振りしていない", () => {
    // 集め方を壊すと全部が黙って通るので、まずファイルの数と、検出器そのものを見る。
    expect(routeFiles.length).toBeGreaterThan(5);
    const sample = [
      "const a = Date.now();",
      "const b = new Date().toISOString();",
      "const c = new Date;",
      "const d = Date();",
      "const e = nowIso();",
      "const f = { now: Date.now };",
      // 以下は変換なので数えない。
      "const g = new Date(0).toISOString();",
      "const h = Date.parse(x);",
      "const i = store.now();",
    ].join("\n");
    expect(realClockReads("sample.ts", sample).map((r) => [r.line, r.form])).toEqual([
      [1, "Date.now"],
      [2, "new Date()"],
      [3, "new Date()"],
      [4, "Date()"],
      [5, "nowIso()"],
      [6, "Date.now"],
    ]);
  });

  it("鍵はルートと変数名で組む", () => {
    const sample = [
      "fastify.post('/x', async () => {",
      "  const realNowMs = Date.now();",
      "  f(new Date());",
      "});",
      "const top = Date.now();",
    ].join("\n");
    expect(realClockReads("s.ts", sample).map((r) => r.key)).toEqual([
      "s.ts POST /x realNowMs",
      "s.ts POST /x -",
      "s.ts - top",
    ]);
  });

  it("許可リストの外で実時刻を読んでいない", () => {
    const unexpected = reads
      .filter((r) => !(r.key in ALLOWED_REAL_CLOCK_READS))
      .map((r) => `src/routes/${r.file}:${r.line} ${r.form}（${r.key}）`);
    expect(
      unexpected,
      "ルートが記録する時刻は `store.now()` から読む（`new Date(store.now())`）。" +
        "実時刻が要るなら理由を添えて ALLOWED_REAL_CLOCK_READS に載せる",
    ).toEqual([]);
  });

  it("許可リストの各エントリはちょうど 1 か所を指し、理由がある", () => {
    for (const [key, reason] of Object.entries(ALLOWED_REAL_CLOCK_READS)) {
      expect(reason.trim(), `${key} の理由が空`).not.toBe("");
      const hits = reads.filter((r) => r.key === key);
      expect(
        hits.map((r) => `src/routes/${r.file}:${r.line} ${r.form}`),
        `${key} は 1 か所だけを指すこと（無くなったならエントリを外す）`,
      ).toHaveLength(1);
      expect(hits[0]!.form).toBe("Date.now");
    }
  });
});

describe("src/routes/ は時刻を store.now() から読む（動的）", () => {
  const build = setupBuildTestServer();

  /** 実時刻から十分に離した、ミリ秒まで狙える時刻。実時刻で記録したら必ず食い違う。 */
  const T = Date.parse("2020-02-03T04:05:06.789Z");
  const iso = (ms: number) => new Date(ms).toISOString();

  /** 時計を `set()` で動かせる store 付きのサーバ。tick の影響を消すため manual で起こす。 */
  async function setup(state = buildState(), candlesByPair: Record<string, Candle[]> = {}) {
    let ms = T;
    const r = await build(state, candlesByPair, {
      fillMode: "manual",
      controlEnabled: true,
      now: () => ms,
    });
    return {
      ...r,
      set: (next: number) => {
        ms = next;
      },
    };
  }

  const LIMIT = { pair: "btc_jpy", side: "buy", type: "limit", price: 4_000_000, amount: 0.001 };

  it("指値の発注: ordered_at", async () => {
    const { fastify } = await setup();
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: LIMIT,
    });
    expect(res.json().data.ordered_at).toBe(T);
  });

  it("成行の発注: ordered_at と、約定価格を取りに行く窓の終端", async () => {
    // 窓（`T - 5 分` 以上 `T` 以下）の中にだけ足を置く。窓が実時刻なら足が見つからず `70001`。
    const { fastify, store } = await setup(buildState(), {
      btc_jpy: [candle(T - 60_000, 4_000_000, 4_000_000, 4_000_000, 4_000_000)],
    });
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/order",
      payload: { pair: "btc_jpy", side: "buy", type: "market", amount: 0.001 },
    });
    expect(res.json().success).toBe(1);
    expect(res.json().data.ordered_at).toBe(T);
    expect(store.state().trades[0]!.executedAt).toBe(iso(T));
    expect(store.candlesHealth().lastSuccessAt).toBe(iso(T));
  });

  it("取消（cancel_order）: canceled_at。発注の時刻は動かない", async () => {
    const { fastify, set } = await setup();
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT });
    set(T + 1_234);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_order",
      payload: { pair: "btc_jpy", order_id: 1 },
    });
    expect(res.json().data.ordered_at).toBe(T);
    expect(res.json().data.canceled_at).toBe(T + 1_234);
  });

  it("一括取消（cancel_orders）: canceled_at", async () => {
    const { fastify, set } = await setup();
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT });
    await fastify.inject({ method: "POST", url: "/v1/user/spot/order", payload: LIMIT });
    set(T + 5_678);
    const res = await fastify.inject({
      method: "POST",
      url: "/v1/user/spot/cancel_orders",
      payload: { pair: "btc_jpy", order_ids: [1, 2] },
    });
    const orders = res.json().data.orders as Array<{ canceled_at: number }>;
    expect(orders.map((o) => o.canceled_at)).toEqual([T + 5_678, T + 5_678]);
  });

  it("/_control/ の fill: 約定時刻", async () => {
    const { fastify, store } = await setup(
      buildState({ orders: [buildOrder({ id: "1", price: 5_000_000, startAmount: 0.001 })] }),
    );
    const res = await fastify.inject({ method: "POST", url: "/_control/orders/1/fill" });
    expect(res.statusCode).toBe(200);
    expect(res.json().trade.executed_at).toBe(T);
    expect(store.state().orders[0]!.updatedAt).toBe(iso(T));
  });

  it("/_control/ の reject: 注文の更新時刻", async () => {
    const { fastify, store } = await setup(buildState({ orders: [buildOrder({ id: "1" })] }));
    const res = await fastify.inject({ method: "POST", url: "/_control/orders/1/reject" });
    expect(res.statusCode).toBe(200);
    expect(store.state().orders[0]!.updatedAt).toBe(iso(T));
  });
});
