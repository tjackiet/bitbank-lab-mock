import {
  amountOf,
  availableOf,
  DEFAULT_TAKER_FEE_RATE,
  isActive,
  isTerminal,
  type OrderRecord,
  type PaperState,
  pairAssets,
  remainingOf,
  type TradeRecord,
} from "./state.ts";
import type { Result } from "./types.ts";

/**
 * `fillOrder` が全約定へクランプする閾値。残量との差がこれ以下なら残量ちょうどを約定させ、
 * これを超える残量超過は `INVALID_AMOUNT` で断る。
 *
 * `src/engine/invariants.ts` の `AMOUNT_ABS_TOL` と**同じ値だが別物**（あちらは不変量 5 の
 * 合計の一致を見る許容差の床）。**連動しない**ので、片方を動かすときもう片方を追従させる
 * 必要は無い。理由は `AMOUNT_ABS_TOL` の項に実測付きで書いてある。
 */
const AMOUNT_EPS = 1e-12;

export const TransitionError = {
  ORDER_NOT_FOUND: "ORDER_NOT_FOUND",
  ORDER_NOT_ACTIVE: "ORDER_NOT_ACTIVE",
  INVALID_AMOUNT: "INVALID_AMOUNT",
  INVALID_PRICE: "INVALID_PRICE",
  INSUFFICIENT_FUNDS: "INSUFFICIENT_FUNDS",
  MARKET_PRICE_REQUIRED: "MARKET_PRICE_REQUIRED",
  INVALID_PAIR: "INVALID_PAIR",
  LIMIT_PRICE_REQUIRED: "LIMIT_PRICE_REQUIRED",
  ORDER_SEQ_EXHAUSTED: "ORDER_SEQ_EXHAUSTED",
  TRADE_SEQ_EXHAUSTED: "TRADE_SEQ_EXHAUSTED",
} as const;

/**
 * 採番がもう一意な id を配れないか。`String(seq)` を配って `seq + 1` へ進める採番は、
 * `seq` が安全整数を外れた時点で `+ 1` が飽和し、以後は同じ id を配り続ける。
 *
 * 読み込み時の検査（`preconditionViolations()`）だけではこれを防げない。検査が見るのは
 * 読み込んだ時点の `seq` で、飽和は実行中の `+ 1` で起きるからである。境界をどこに引いても
 * 「あと数件で飽和する `seq`」は検査を通ってしまい、その数件を配った後に重複が出る
 * （`Number.MAX_SAFE_INTEGER` を弾いても `MAX_SAFE_INTEGER - 1` が同じ道を辿る）。
 * だから配る側で止める。ここで断る限り、配った id は必ず直前より大きく、重複しない。
 *
 * 本モックの採番は 1 から 1 ずつ進むので、通常の利用でここに到達することはない
 * （`2^53` 件の発注が要る）。届くのは state ファイルに手で大きな採番を書いた場合と、
 * 巨大な id を持つ v1 / v2 を移行した場合だけである（docs/fidelity.md の「不変量の前提」）。
 */
function canIssue(seq: number): boolean {
  return Number.isSafeInteger(seq);
}

export type PlaceOrderInput = {
  pair: string;
  side: "buy" | "sell";
  type: "limit" | "market";
  amount: number;
  price?: number;
};

export type TransitionOk = {
  state: PaperState;
  order: OrderRecord;
  trade?: TradeRecord;
};

function ok(data: TransitionOk): Result<TransitionOk> {
  return { success: true, data };
}

function fail(error: string): Result<TransitionOk> {
  return { success: false, error };
}

function replaceOrder(state: PaperState, order: OrderRecord): PaperState {
  return {
    ...state,
    orders: state.orders.map((o) => (o.id === order.id ? order : o)),
    updatedAt: order.updatedAt,
  };
}

/**
 * 新しい注文を板に載せる。**指値は `UNFILLED` で載せて終わり、成行はその場で全量約定させる**
 * （成行は種となる注文を積んでから `fillOrder` へ渡すので、返るのは約定済みのレコード）。
 *
 * 検査はこの順で、どれか 1 つでも落ちたら**状態を変えずに**失敗を返す。
 *
 * 1. ペアの文字種（`pairAssets`）— `INVALID_PAIR`
 * 2. `amount` が有限かつ正 — `INVALID_AMOUNT`
 * 3. 採番が飽和していないこと（`canIssue`）— `ORDER_SEQ_EXHAUSTED`
 * 4. 基準価格が有限かつ正 — 指値は `price` が要る（`LIMIT_PRICE_REQUIRED`）、
 *    成行は `marketPrice` が要る（`MARKET_PRICE_REQUIRED`）
 * 5. 残高 — `INSUFFICIENT_FUNDS`
 *
 * 残高の判定は `availableOf`（残高 − 拘束）に対して行い、買いは基準価格 × 数量 ×
 * `(1 + feeRate)` を quote に、売りは数量を base に要求する。手数料込みにするのは
 * `computeLocked` の拘束式と同じ基準で見るためで、ここがずれると不変量 6 が破れる。
 */
export function placeOrder(
  state: PaperState,
  input: PlaceOrderInput,
  now: string,
  marketPrice?: number,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Result<TransitionOk> {
  const assets = pairAssets(input.pair);
  if (!assets) return fail(TransitionError.INVALID_PAIR);
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return fail(TransitionError.INVALID_AMOUNT);
  }
  // 飽和した採番からは注文を作らない（同じ id を 2 回配らないため）。指値・成行の
  // どちらも `String(state.nextOrderSeq)` を配るので、分岐の手前で 1 度だけ見る。
  if (!canIssue(state.nextOrderSeq)) return fail(TransitionError.ORDER_SEQ_EXHAUSTED);

  const [base, quote] = assets;
  const isLimit = input.type === "limit";
  // 残高ガードの基準価格。指値は注文価格を、成行は約定に使う市場価格を見る。
  // 「有限かつ正」という条件は両者で同じで、欠けたときに返すコードだけが種別で変わる。
  const refPrice = isLimit ? input.price : marketPrice;
  if (refPrice === undefined || !Number.isFinite(refPrice) || refPrice <= 0) {
    return fail(
      isLimit ? TransitionError.LIMIT_PRICE_REQUIRED : TransitionError.MARKET_PRICE_REQUIRED,
    );
  }
  // 買いは quote を手数料込みの代金で、売りは base を数量で拘束する（`computeLocked` と同じ式）。
  const lockedAsset = input.side === "buy" ? quote : base;
  const need = input.side === "buy" ? refPrice * input.amount * (1 + feeRate) : input.amount;
  if (availableOf(state, lockedAsset, feeRate) < need) {
    return fail(TransitionError.INSUFFICIENT_FUNDS);
  }

  const order: OrderRecord = {
    id: String(state.nextOrderSeq),
    pair: input.pair,
    side: input.side,
    type: input.type,
    // 成行は約定価格を持たない（`price` は指値の注文価格を表すフィールド）。
    price: isLimit ? refPrice : null,
    startAmount: input.amount,
    executedAmount: 0,
    executedNotional: 0,
    status: "UNFILLED",
    orderedAt: now,
    canceledAt: null,
    updatedAt: now,
  };
  const placed: PaperState = {
    ...state,
    orders: [...state.orders, order],
    nextOrderSeq: state.nextOrderSeq + 1,
    updatedAt: now,
  };
  // 指値は板に載せて終わり。成行はその場で全量約定させる（`fillOrder` が trade と残高を作る）。
  if (isLimit) return ok({ state: placed, order });
  return fillOrder(placed, order.id, refPrice, input.amount, now, feeRate);
}

/**
 * active な注文へ約定を 1 件適用し、注文・trade・残高を同じ返り値で更新する。
 *
 * 部分適用が起きないので不変量 5（trade の合計 == `executedAmount`）を保てる。
 * 残量との差が `AMOUNT_EPS` 以下なら全約定として残量ちょうどに丸め、
 * `FULLY_FILLED` にする（不変量 1・3）。指値では order price より不利な価格を
 * `INVALID_PRICE` で断るので、発注時に拘束した分を超えて使わない（不変量 6）。
 *
 * 終端・不在の注文、非正や残量超過の量、不正なペアは状態を変えずに失敗を返す。
 */
export function fillOrder(
  state: PaperState,
  orderId: string,
  price: number,
  amount: number,
  at: string,
  feeRate: number = DEFAULT_TAKER_FEE_RATE,
): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (!isActive(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);
  // trade も同じ採番で id を配る。飽和していれば約定させない（状態は変えない）。
  if (!canIssue(state.nextTradeSeq)) return fail(TransitionError.TRADE_SEQ_EXHAUSTED);
  const remaining = remainingOf(current);
  if (!Number.isFinite(amount) || amount <= 0 || amount - remaining > AMOUNT_EPS) {
    return fail(TransitionError.INVALID_AMOUNT);
  }
  const fully = remaining - amount <= AMOUNT_EPS;
  const fillAmount = fully ? remaining : amount;
  if (!Number.isFinite(price) || price <= 0) return fail(TransitionError.INVALID_PRICE);
  if (current.type === "limit" && current.price != null) {
    const worse = current.side === "buy" ? price > current.price : price < current.price;
    if (worse) return fail(TransitionError.INVALID_PRICE);
  }

  const assets = pairAssets(current.pair);
  if (!assets) return fail(TransitionError.INVALID_PAIR);
  const [base, quote] = assets;
  const notional = price * fillAmount;
  const feeQuote = notional * feeRate;
  const balances = { ...state.balances };
  if (current.side === "buy") {
    balances[quote] = amountOf(balances, quote) - (notional + feeQuote);
    balances[base] = amountOf(balances, base) + fillAmount;
  } else {
    balances[base] = amountOf(balances, base) - fillAmount;
    balances[quote] = amountOf(balances, quote) + (notional - feeQuote);
  }

  const executedAmount = fully ? current.startAmount : current.executedAmount + fillAmount;
  const executedNotional = current.executedNotional + notional;
  const order: OrderRecord = {
    ...current,
    executedAmount,
    executedNotional,
    status: fully ? "FULLY_FILLED" : "PARTIALLY_FILLED",
    updatedAt: at,
  };
  const trade: TradeRecord = {
    tradeId: String(state.nextTradeSeq),
    orderId: current.id,
    pair: current.pair,
    side: current.side,
    type: current.type,
    amount: fillAmount,
    price,
    feeQuote,
    makerTaker: current.type === "limit" ? "maker" : "taker",
    executedAt: at,
  };

  return ok({
    state: {
      ...replaceOrder(state, order),
      balances,
      trades: [...state.trades, trade],
      nextTradeSeq: state.nextTradeSeq + 1,
      updatedAt: at,
    },
    order,
    trade,
  });
}

/**
 * active な注文を取り消す。部分約定済みなら `CANCELED_PARTIALLY_FILLED`、
 * 未約定なら `CANCELED_UNFILLED` にし、`canceledAt` と `updatedAt` を `at` で埋める。
 * 約定量・約定代金・残高は動かさない（取消は既に約定した分を取り消さない）。
 *
 * ガードが 2 段あるのは拾う範囲が違うため。`isTerminal` が終端の 4 状態を、続く
 * `!isActive` が残る `INACTIVE` を落とす。どちらも `ORDER_NOT_ACTIVE` を返す。
 * 不在は `ORDER_NOT_FOUND`。いずれも状態は変えない。
 */
export function cancelOrder(state: PaperState, orderId: string, at: string): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (isTerminal(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);
  if (!isActive(current)) return fail(TransitionError.ORDER_NOT_ACTIVE);

  const order: OrderRecord = {
    ...current,
    status:
      current.status === "PARTIALLY_FILLED" ? "CANCELED_PARTIALLY_FILLED" : "CANCELED_UNFILLED",
    canceledAt: at,
    updatedAt: at,
  };
  return ok({ state: replaceOrder(state, order), order });
}

/**
 * 注文を `REJECTED` にする。受け付けるのは `UNFILLED` と `INACTIVE` だけで、
 * それ以外は `ORDER_NOT_ACTIVE`、不在は `ORDER_NOT_FOUND`（状態は変えない）。
 * 約定済みの注文を拒否できないのは不変量 2（`REJECTED` の約定量は 0）を保つため。
 *
 * **呼び出し元は `/_control/` の `POST /_control/orders/:order_id/reject` だけで、互換ルートは
 * 呼ばない**（実 API がどの条件で `REJECTED` にするかは公式に書かれていない）。応答経路で
 * `REJECTED` に出会うのは、この口で拒否した注文と、状態ファイルが最初からその状態を持っていた
 * 注文である（`PaperStateSchema` は status を enum で受けるので読み込みは通る）。
 * `src/routes/cancel-order.ts` はどちらも `ORDER_NOT_FOUND` に落とす。
 */
export function rejectOrder(state: PaperState, orderId: string, at: string): Result<TransitionOk> {
  const current = state.orders.find((o) => o.id === orderId);
  if (!current) return fail(TransitionError.ORDER_NOT_FOUND);
  if (current.status !== "UNFILLED" && current.status !== "INACTIVE") {
    return fail(TransitionError.ORDER_NOT_ACTIVE);
  }

  const order: OrderRecord = {
    ...current,
    status: "REJECTED",
    updatedAt: at,
  };
  return ok({ state: replaceOrder(state, order), order });
}
