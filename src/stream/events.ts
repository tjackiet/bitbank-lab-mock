import type { OrderRecord, PaperState, TradeRecord } from "../engine/state.ts";
import {
  type AssetKeyStyle,
  type AssetShape,
  formatAsset,
  formatAssets,
  formatAssetUpdate,
  formatStreamOrder,
  formatTrade,
} from "../routes/format.ts";

/**
 * このモックが送る private stream のメソッド。公式 `private-stream.md` が定義する 11 のうち
 * **現物の 4 つ**である。
 *
 * - `spot_order_invalidation` は送らない。発生条件（マッチングエンジン内の資産不足）が
 *   このモックでは構造的に起こり得ない
 *   （`docs/fidelity.md` の「private stream の `spot_order_invalidation`」）
 * - ディーラー・入出金・信用取引の 6 つ（`dealer_order_new` / `withdrawal` / `deposit` /
 *   `margin_*`）は、対応する機能をこのモックが持たない
 */
export type PrivateStreamMethod = "spot_order_new" | "spot_order" | "spot_trade" | "asset_update";

/**
 * 1 通のメッセージ。公式の形 `{ "message": { "method", "params" } }` そのもので、
 * WebSocket の 1 フレームに JSON 1 つを載せる。
 *
 * **`params` は常に要素 1 つの配列**にする。公式の例のコード（`private-stream.md:666`）は
 * `data.message.params[0]` だけを読むので、複数を詰めるとその写し方をした利用側が
 * 2 つ目以降を黙って落とす。実 API が複数を詰めることがあるかは確かめていない
 * （`docs/fidelity.md` の「private stream のメッセージ」）。
 */
export type PrivateStreamMessage = {
  message: { method: PrivateStreamMethod; params: [unknown] };
};

export type StateChangeMessageOptions = {
  /** 拘束額の計算に使う料率。`SessionStore.feeRate` を渡す（REST の `locked_amount` と揃える）。 */
  feeRate: number;
  /** `asset_update` のキーの綴り。 */
  assetKeys: AssetKeyStyle;
};

/**
 * 状態の差し替え 1 回（`prev` → `next`）を、送るメッセージの列にする。
 *
 * **遷移関数の戻り値ではなく、2 つの状態の差から作る。** 状態を変える経路には、戻り値から
 * 個々の変化を復元できないものがある（一括取消は n 件を畳んで 1 回だけ `commit()` し、
 * `SessionStore.tick()` は `commit()` を通らない。`docs/plan-lab-mock.md` 14.1 の (3)）。
 * 差から作れば、経路が何であっても**状態に現れた変化だけが、漏れなく**流れる。
 *
 * 並べ方は**注文 → 約定 → 資産**で固定する。1 回の差し替えの中ではこの順に送るが、
 * **公式は配信の順序を保証していない**ので、利用側はこの順に依存しないこと
 * （`docs/fidelity.md` の「private stream の順序」）。
 *
 * - **注文**: `next` に初めて現れた注文は `spot_order_new`、`prev` にもあって wire 上の
 *   見え方（`formatStreamOrder()` の結果）が変わった注文は `spot_order`。並びは `next.orders`
 *   の順（＝発注順）。**1 回の差し替えで 1 注文につき 1 通**なので、発注と同時に全量約定する
 *   成行は `spot_order_new` が 1 通だけ、`status: "FULLY_FILLED"` で届く
 * - **約定**: `next` に初めて現れた trade を `spot_trade` で、記録順に
 * - **資産**: `GET /v1/user/assets` と同じ整形で見え方が変わった資産を `asset_update` で、
 *   1 資産 1 通。`next` の一覧から消えた資産は 0 として送る
 *
 * **消えた注文・消えた約定は送らない。** 遷移関数を通る限り注文と約定は消えない
 * （消えるのは `POST /_control/reset` だけで、その場合 private stream は接続を切る。
 * `src/stream/hub.ts`）。公式にも「消えた」を表すメソッドは無い。
 */
export function stateChangeMessages(
  prev: PaperState,
  next: PaperState,
  opts: StateChangeMessageOptions,
): PrivateStreamMessage[] {
  return [
    ...orderMessages(prev, next),
    ...tradeMessages(prev, next),
    ...assetMessages(prev, next, opts),
  ];
}

function message(method: PrivateStreamMethod, param: unknown): PrivateStreamMessage {
  return { message: { method, params: [param] } };
}

/**
 * 注文 id → その注文の約定のうち最も遅い `executedAt`。`formatStreamOrder()` の
 * `executed_at` の元になる。
 *
 * 「最後に記録した約定」ではなく「最も遅い時刻」を採る。`POST /_control/tick` は過去の足を
 * 流し直せるので、記録順と時刻順が食い違うことがある（`docs/fidelity.md` の
 * 「control の時計」）。時刻として解釈できない値（壊れた状態ファイル）は比較で負けるので、
 * 解釈できる値があればそちらが残る。
 */
function lastExecutedAtByOrder(trades: TradeRecord[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const t of trades) {
    const current = out.get(t.orderId);
    if (current === undefined || Date.parse(t.executedAt) > Date.parse(current)) {
      out.set(t.orderId, t.executedAt);
    }
  }
  return out;
}

function orderMessages(prev: PaperState, next: PaperState): PrivateStreamMessage[] {
  // 注文も約定も同じ配列のままなら、どの注文の見え方も変わっていない。時計だけを動かす
  // 差し替え（`tick()` の末尾、`POST /_control/clock`）はここで抜ける。
  if (prev.orders === next.orders && prev.trades === next.trades) return [];
  const before = new Map<string, OrderRecord>(prev.orders.map((o) => [o.id, o]));
  const prevExecutedAt = lastExecutedAtByOrder(prev.trades);
  const nextExecutedAt =
    prev.trades === next.trades ? prevExecutedAt : lastExecutedAtByOrder(next.trades);
  const out: PrivateStreamMessage[] = [];
  for (const o of next.orders) {
    const old = before.get(o.id);
    const executedAt = nextExecutedAt.get(o.id);
    if (old === undefined) {
      out.push(message("spot_order_new", formatStreamOrder(o, executedAt)));
      continue;
    }
    // 遷移関数は変えない注文のレコードを使い回す（`replaceOrder()`）ので、同じ参照なら
    // 整形するまでもなく変わっていない。約定時刻だけは別の配列から来るので併せて見る。
    if (old === o && prevExecutedAt.get(o.id) === executedAt) continue;
    const now = formatStreamOrder(o, executedAt);
    if (sameJson(formatStreamOrder(old, prevExecutedAt.get(o.id)), now)) continue;
    out.push(message("spot_order", now));
  }
  return out;
}

function tradeMessages(prev: PaperState, next: PaperState): PrivateStreamMessage[] {
  if (prev.trades === next.trades) return [];
  const seen = new Set(prev.trades.map((t) => t.tradeId));
  return next.trades
    .filter((t) => !seen.has(t.tradeId))
    .map((t) => message("spot_trade", formatTrade(t)));
}

function assetMessages(
  prev: PaperState,
  next: PaperState,
  opts: StateChangeMessageOptions,
): PrivateStreamMessage[] {
  // 拘束額は active な注文から計算するので、残高と注文の両方が同じ配列なら資産は動いていない。
  if (prev.balances === next.balances && prev.orders === next.orders) return [];
  const before = new Map<string, AssetShape>(
    formatAssets(prev, opts.feeRate).assets.map((a) => [a.asset, a]),
  );
  const out: PrivateStreamMessage[] = [];
  for (const a of formatAssets(next, opts.feeRate).assets) {
    const old = before.get(a.asset);
    before.delete(a.asset);
    const now = formatAssetUpdate(a, opts.assetKeys);
    if (old !== undefined && sameJson(formatAssetUpdate(old, opts.assetKeys), now)) continue;
    out.push(message("asset_update", now));
  }
  // `prev` の一覧にだけあった資産は、残高も拘束も無くなって一覧から外れた。0 として送る
  // （もともと 0 だったなら見え方は変わっていないので送らない）。
  for (const old of before.values()) {
    const now = formatAssetUpdate(formatAsset(old.asset, 0, 0), opts.assetKeys);
    if (sameJson(formatAssetUpdate(old, opts.assetKeys), now)) continue;
    out.push(message("asset_update", now));
  }
  return out;
}

/**
 * wire 上の見え方が同じか。整形関数はキーを決まった順で組み立てるので、JSON の文字列で
 * 比べてよい（キーの順が揺れる入力は来ない）。
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
