import { formatAmount, formatPrice } from "../engine/precision.ts";
import {
  amountOf,
  computeLocked,
  isActive,
  type OrderRecord,
  type OrderStatus,
  type PaperState,
  remainingOf,
  type TradeRecord,
} from "../engine/state.ts";

// このファイルは「レコード → wire の 1 オブジェクト」を作る。
// 数値 → ペア桁の文字列にする `formatAmount()` / `formatPrice()` は engine 側
// （`src/engine/precision.ts`）にあり、別の層である。名前が似ているので取り違えないこと。

/**
 * 残高が無くても `GET /v1/user/assets` に必ず出す資産。
 *
 * **この 10 個という選び方に公式の根拠は無い**（実装当初からの値で、導出も出典も残っていない）。
 * 公式は「assets が何を返すか」の集合を明記しておらず、実 API も測っていない。
 * `src/engine/pairs.ts` の `OFFICIAL_PAIRS`（62 ペア＝48 資産）とは**別の集合**で、
 * 連動していない。残りの 38 資産は残高か拘束を持つまで応答に現れない。
 *
 * 変えるなら実 API の実測が要る。未確定であることは `docs/fidelity.md` の
 * 「assets に出る資産」節に記録した。一覧は `tests/routes/assets.test.ts` が固定している。
 */
const KNOWN_ASSETS = ["jpy", "btc", "eth", "xrp", "ltc", "bcc", "mona", "xlm", "qtum", "bat"];

/** 資産残高の桁。jpy は 4、他は 8。応答の amount_precision と同一の値を使う。 */
const ASSET_AMOUNT_PRECISION: Record<string, number> = { jpy: 4 };
const DEFAULT_ASSET_AMOUNT_PRECISION = 8;

/** 公式の資産応答が jpy だけ形を変えるフィールドがあるため、判定に使う。 */
const JPY = "jpy";

/** 代用掛け目。Plan A は信用取引を実装しないので 0 固定。 */
const COLLATERAL_RATIO = "0";

/**
 * 注文オブジェクト。公式の「Fetch order information」「Create new order」
 * 「Cancel order」「Fetch multiple orders」「Fetch active orders」は同一の形を返す
 * （公式は後者 2 つを "list of object same as ..." と定義する）。`canceled_at` を
 * 応答表に持つのは「Cancel order」だけで、他の節の表には無い。
 * 未実装のため常に出さないフィールド: position_side / triggered_at / trigger_price。
 */
export type OrderShape = {
  order_id: number | string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  start_amount: string;
  remaining_amount: string;
  executed_amount: string;
  price?: string;
  post_only?: boolean;
  user_cancelable: boolean;
  average_price: string;
  ordered_at: number;
  expire_at: null;
  canceled_at?: number;
  status: OrderStatus;
};

export function formatAveragePrice(o: OrderRecord): string {
  if (o.executedAmount === 0) return "0";
  return formatPrice(o.pair, o.executedNotional / o.executedAmount);
}

export function formatOrder(o: OrderRecord): OrderShape {
  const shape: OrderShape = {
    order_id: toIdOut(o.id),
    pair: o.pair,
    side: o.side,
    type: o.type,
    start_amount: formatAmount(o.pair, o.startAmount),
    remaining_amount: formatAmount(o.pair, remainingOf(o)),
    executed_amount: formatAmount(o.pair, o.executedAmount),
    user_cancelable: isActive(o),
    average_price: formatAveragePrice(o),
    ordered_at: Date.parse(o.orderedAt),
    expire_at: null,
    status: o.status,
  };
  // 公式は price と post_only の出現条件を別に定める。price は type = limit / stop_limit、
  // post_only は type = limit。stop_limit は Plan A で未実装なので limit だけを見る。
  if (o.type === "limit" && o.price != null) {
    shape.price = formatPrice(o.pair, o.price);
  }
  if (o.type === "limit") {
    shape.post_only = false;
  }
  if (o.canceledAt != null) {
    shape.canceled_at = Date.parse(o.canceledAt);
  }
  return shape;
}

/**
 * private stream の `spot_order_new` / `spot_order` が載せる注文オブジェクト。
 *
 * **REST の注文オブジェクト（`OrderShape`）のスーパーセット**で、公式のフィールド表
 * （`private-stream.md:115-136` / `private-stream_JP.md:116-137`）が REST の
 * Fetch order information の表に対して足している 2 つを持つ。`spot_order` の内容は
 * 「`spot_order_new` と同一」と公式が明記するので（`private-stream.md:176`）、形は 1 つ。
 *
 * - `executed_at`: **常に出す。** 約定があれば値はそのうち最も遅い約定時刻、**約定が無ければ
 *   `0`**。英日どちらの表も型を `number`（`| undefined` も `| null` も付かない）と書くので
 *   キーは省かない。`0` は応答例の値に合わせたもので、実 API が約定の無い注文に何を返すかは
 *   確かめていない。公式は「最初・最後・直近のどの約定の時刻か」も書いていない
 *   （`docs/fidelity.md` の「private stream の注文ペイロード」）
 * - `is_just_triggered`: **常に `false`。** 逆指値のトリガという概念がこのモックに無いので、
 *   「たった今トリガされた」注文は存在しない（型は `boolean` で常に出る）
 *
 * `price` / `canceled_at` / `expire_at` の扱いは REST のまま変えない。**stream の表は英日で
 * この 3 つの型が食い違う**が、どれも REST の表（英日とも）と stream の片方の言語版が
 * 揃っている側に REST がすでに乗っている（同じ節に英日差の表がある）。
 *
 * REST と同じく `position_side` / `trigger_price` / `triggered_at` は出さない
 * （`docs/fidelity.md` の「信用取引・逆指値の項目」）。
 */
export type StreamOrderShape = OrderShape & {
  executed_at: number;
  is_just_triggered: boolean;
};

/**
 * stream の注文オブジェクト。`lastExecutedAt` は呼び出し側がその注文の約定から引いて渡す
 * （`OrderRecord` は約定時刻を持たないので、ここでは導けない）。約定が無ければ `undefined`。
 */
export function formatStreamOrder(
  o: OrderRecord,
  lastExecutedAt: string | undefined,
): StreamOrderShape {
  return {
    ...formatOrder(o),
    executed_at: lastExecutedAt === undefined ? NO_EXECUTION_AT : Date.parse(lastExecutedAt),
    is_just_triggered: false,
  };
}

/**
 * 約定の無い注文の `executed_at`。英日どちらの表も型を `number` と書く（省略も `null` も
 * 許していない）ので、値を置く必要がある。**`0` は公式の応答例の値**で、実 API が何を返すかは
 * 確かめていない（`docs/fidelity.md` の「private stream の注文ペイロード」）。
 */
const NO_EXECUTION_AT = 0;

export type TradeShape = {
  trade_id: number | string;
  order_id: number | string;
  pair: string;
  side: "buy" | "sell";
  type: "market" | "limit";
  amount: string;
  price: string;
  maker_taker: "maker" | "taker";
  fee_amount_base: string;
  fee_amount_quote: string;
  fee_occurred_amount_quote: string;
  executed_at: number;
};

/**
 * 約定オブジェクト。公式の「Fetch trade history」の応答表に対応する。
 * 未実装のため常に出さないフィールド: position_side / profit_loss / interest。
 */
export function formatTrade(t: TradeRecord): TradeShape {
  const quote = formatFixedQuote(t.feeQuote);
  return {
    trade_id: toIdOut(t.tradeId),
    order_id: toIdOut(t.orderId),
    pair: t.pair,
    side: t.side,
    type: t.type,
    amount: formatAmount(t.pair, t.amount),
    price: formatPrice(t.pair, t.price),
    maker_taker: t.makerTaker,
    fee_amount_base: "0",
    fee_amount_quote: quote,
    // 公式は「現物取引では fee_amount_quote と同値」と明記する。
    fee_occurred_amount_quote: quote,
    executed_at: Date.parse(t.executedAt),
  };
}

/**
 * 出金手数料。公式は資産で形を変え、jpy はしきい値つき、他資産は下限・上限の組を返す。
 */
export type WithdrawalFeeShape =
  | { min: string; max: string }
  | { under: string; over: string; threshold: string };

/** `network_list` の要素。Plan A はネットワークを模さないので一覧は常に空。 */
export type NetworkShape = {
  asset: string;
  network: string;
  stop_deposit: boolean;
  stop_withdrawal: boolean;
  withdrawal_fee: string;
};

export type AssetShape = {
  asset: string;
  free_amount: string;
  amount_precision: number;
  onhand_amount: string;
  locked_amount: string;
  withdrawing_amount: string;
  withdrawal_fee: WithdrawalFeeShape;
  stop_deposit: boolean;
  stop_withdrawal: boolean;
  /** 公式は jpy でだけ省略する。 */
  network_list?: NetworkShape[];
  collateral_ratio: string;
};

/**
 * `GET /v1/user/assets` の資産一覧を組み立てる。既知資産に state の残高と
 * 拘束額のキーを足した集合を返し、金額は宣言する `amount_precision` の桁で揃える。
 *
 * **`feeRate` に既定値を持たせない。** 拘束額は `price × amount × (1 + feeRate)` なので、
 * 渡し忘れると発注ガード（`availableOf` は `SessionStore` の率で引く）と応答の
 * `locked_amount` が別の率で計算され、**free_amount が発注できる量と食い違う**。
 * 既定値があったころは実際に `src/routes/assets.ts` が渡し忘れており、率を `0.05` に
 * した状態で拘束 1,050,000 に対し応答は 1,001,200（既定 0.0012）を返していた。
 * typecheck もテスト 437 件も通ってしまうので、呼び出し側に必ず書かせる。
 */
export function formatAssets(
  state: PaperState,
  feeRate: number,
): {
  assets: AssetShape[];
} {
  const locked = computeLocked(state, feeRate);
  const assetSet = new Set<string>([
    ...KNOWN_ASSETS,
    ...Object.keys(state.balances),
    ...Object.keys(locked),
  ]);
  const assets: AssetShape[] = [];
  for (const a of assetSet) {
    assets.push(formatAsset(a, amountOf(state.balances, a), amountOf(locked, a)));
  }
  return { assets };
}

/**
 * 資産 1 つぶんの応答オブジェクト。`formatAssets()` の 1 要素と同じものを、残高と拘束額から作る。
 *
 * **private stream も同じ関数を通す**（`asset_update` は `formatAssets()` の出力から作り、
 * 一覧から消えた資産だけはここへ `0` を渡して作る）。REST と stream で桁や切り捨ての規則が
 * 分かれないよう、金額の文字列化はこの 1 か所にしか置かない。
 */
export function formatAsset(asset: string, onhand: number, locked: number): AssetShape {
  const digits = assetPrecision(asset);
  const amounts = assetAmounts(onhand, locked, digits);
  return {
    asset,
    free_amount: amounts.free,
    amount_precision: digits,
    onhand_amount: amounts.onhand,
    locked_amount: amounts.locked,
    withdrawing_amount: formatUnits(0n, digits),
    withdrawal_fee: withdrawalFee(asset, digits),
    stop_deposit: false,
    stop_withdrawal: false,
    // 公式の network_list は jpy でだけ undefined になる。キー自体を出さない。
    ...(asset === JPY ? {} : { network_list: [] }),
    collateral_ratio: COLLATERAL_RATIO,
  };
}

/**
 * private stream の `asset_update` のキーの綴り。**公式が同じ節の中で割れている**
 * （フィールド表は snake_case、JSON 応答例は camelCase。英日とも同じ構造）ので、
 * どちらでも送れるようにしてある。既定は `camel`（`BITBANK_MOCK_STREAM_ASSET_KEYS`。
 * 理由は `docs/fidelity.md` の「private stream の `asset_update` のキー」）。
 */
export type AssetKeyStyle = "camel" | "snake";

/** `asset_update` の 1 要素（snake_case の綴り）。公式のフィールド表の 6 行そのもの。 */
export type AssetUpdateSnakeShape = {
  asset: string;
  amount_precision: number;
  free_amount: string;
  locked_amount: string;
  onhand_amount: string;
  withdrawing_amount: string;
};

/** `asset_update` の 1 要素（camelCase の綴り）。公式の JSON 応答例のキーそのもの。 */
export type AssetUpdateCamelShape = {
  asset: string;
  amountPrecision: number;
  freeAmount: string;
  lockedAmount: string;
  onhandAmount: string;
  withdrawingAmount: string;
};

/**
 * REST の資産オブジェクトから `asset_update` の 1 要素を作る。値は**写すだけ**で計算しない
 * （`GET /v1/user/assets` と同じ時点の状態なら、同じ文字列が出る）。
 */
export function formatAssetUpdate(
  a: AssetShape,
  keys: AssetKeyStyle,
): AssetUpdateSnakeShape | AssetUpdateCamelShape {
  if (keys === "snake") {
    return {
      asset: a.asset,
      amount_precision: a.amount_precision,
      free_amount: a.free_amount,
      locked_amount: a.locked_amount,
      onhand_amount: a.onhand_amount,
      withdrawing_amount: a.withdrawing_amount,
    };
  }
  return {
    asset: a.asset,
    amountPrecision: a.amount_precision,
    freeAmount: a.free_amount,
    lockedAmount: a.locked_amount,
    onhandAmount: a.onhand_amount,
    withdrawingAmount: a.withdrawing_amount,
  };
}

/**
 * 応答で宣言する amount_precision。丸めにも同じ値を使う。
 *
 * 資産名は state ファイル由来のペアから来るので、`constructor` のように
 * `Object.prototype` が持つ名前で引かれ得る。素の `[asset] ?? 既定` だと継承値（関数）を
 * 掴んで桁が関数になり、`formatUnits` が壊れる。自分のキーだけを見る。
 */
function assetPrecision(asset: string): number {
  return Object.hasOwn(ASSET_AMOUNT_PRECISION, asset)
    ? ASSET_AMOUNT_PRECISION[asset]
    : DEFAULT_ASSET_AMOUNT_PRECISION;
}

/**
 * 出金手数料。Plan A は出金を実装しないので値は全て 0 で、形だけ公式に合わせる。
 * 桁は同じ応答で宣言する amount_precision に揃え、他の金額と表記を統一する。
 */
function withdrawalFee(asset: string, digits: number): WithdrawalFeeShape {
  const zero = formatUnits(0n, digits);
  if (asset === JPY) return { under: zero, over: zero, threshold: zero };
  return { min: zero, max: zero };
}

/**
 * 残高と拘束額を桁つきの 10 進文字列にする。最小単位の整数へ丸めてから free を
 * 差で求めるので、3 値の間で free == onhand - locked が文字列として成り立つ。
 * 非有限な値（壊れた state）は丸めずそのまま出し、異常を隠さない。
 */
function assetAmounts(
  onhand: number,
  locked: number,
  digits: number,
): { free: string; onhand: string; locked: string } {
  if (!Number.isFinite(onhand) || !Number.isFinite(locked)) {
    return { free: String(onhand - locked), onhand: String(onhand), locked: String(locked) };
  }
  const onhandUnits = toMinimumUnits(onhand, digits);
  const lockedUnits = toMinimumUnits(locked, digits);
  return {
    free: formatUnits(onhandUnits - lockedUnits, digits),
    onhand: formatUnits(onhandUnits, digits),
    locked: formatUnits(lockedUnits, digits),
  };
}

/** `Number#toString` の 10 進表記を分解する（符号・整数部・小数部・指数部）。 */
const DECIMAL_PARTS = /^(-?)(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

/**
 * 有限の number を最小単位の整数へ**切り捨てる**。倍精度の乗算を挟まず
 * 10 進表記を bigint で桁合わせするので、`Number.MAX_SAFE_INTEGER` を超える
 * 桁でも指数表記に落ちない。
 *
 * **四捨五入から切り捨てへ変えたのは実測による**（2026-09-17）。実 API に約定しない
 * 指値買いを 1 本置いて `locked_amount` の増分を測ったところ、厳密値
 * `1001.19088908` に対し `1001.1908` が返った。四捨五入なら `1001.1909` になる。
 * `docs/fidelity.md` の「残高の桁」節に未確定として残していた論点である。
 *
 * **区別できていないこと**: 「合計を切り捨てる」のか「手数料を切り捨ててから足す」のかは
 * 決まっていない。観測が 1 点だったからではなく**構造的**で、`price` が整数なら
 * `price × amount` が表示桁の格子に乗るため 2 つの規則は一致する。**条件は格子に乗ること**で
 * 「価格が整数であること」ではない——桁検査は整数から `1e-8` 未満のずれを許すので、
 * 大きな数量と組めばモックの上でも分かれ得る（`docs/fidelity.md` の「残高の桁」節）。**負値の扱いも未実測**で、
 * ここでは 0 方向への切り捨て（絶対値を小さくする向き）にしている。`free_amount` は
 * 負になり得るので（同じ行）、実 API がそこで -∞ 方向へ倒すなら差が出る。
 *
 * **切り捨ては倍精度の塵に弱いので、先に落とす。** 四捨五入なら塵は吸収されていたが、
 * 切り捨てでは表示桁を 1 つ下げてしまう。例: `computeLocked` の `50 × 0.575 × 1.0012` は
 * 数学的には `28.7845` ちょうどだが倍精度では `28.784499999999998` になり、
 * そのまま切り捨てると `28.7844` になる。`toPrecision(15)` で意図した 10 進値へ寄せてから
 * 桁を合わせる（倍精度が往復で保証するのは 15 桁）。
 *
 * ただし `1e15` 以上には当てない。有効桁が削れて整数部が変わるうえ、その大きさでは
 * ulp が `0.125` 以上あって表示桁（`1e-4`）より粗く、塵が表示に届かないためである。
 */
/** `toPrecision(15)` で塵を落とす上限。これ以上は ulp が表示桁より粗い（docstring）。 */
const DUST_SNAP_LIMIT = 1e15;

function toMinimumUnits(n: number, digits: number): bigint {
  const text = Math.abs(n) < DUST_SNAP_LIMIT ? n.toPrecision(15) : n.toString();
  const parts = DECIMAL_PARTS.exec(text);
  if (!parts) return 0n;
  const [, sign, int, frac = "", exp = "0"] = parts;
  const mantissa = BigInt(int + frac);
  // n = ±mantissa × 10^(exp - frac.length) なので、最小単位への換算はこの指数。
  const shift = Number(exp) - frac.length + digits;
  if (shift >= 0) {
    const scaled = mantissa * 10n ** BigInt(shift);
    return sign === "-" ? -scaled : scaled;
  }
  const divisor = 10n ** BigInt(-shift);
  // bigint の除算は 0 方向へ切り捨てる。mantissa は数字列から作るので非負で、
  // 符号は最後に付け直す。
  const quotient = mantissa / divisor;
  return sign === "-" ? -quotient : quotient;
}

/**
 * 最小単位の整数を固定桁の 10 進文字列にする。bigint なので指数表記にならず、
 * 倍精度の除算も挟まないので塵が戻らない。負値はそのまま負のまま出す
 * （不変量 6 の違反を表示で隠さない）。
 */
function formatUnits(units: bigint, digits: number): string {
  const sign = units < 0n ? "-" : "";
  const abs = (units < 0n ? -units : units).toString();
  if (digits === 0) return sign + abs;
  const padded = abs.padStart(digits + 1, "0");
  const cut = padded.length - digits;
  return `${sign}${padded.slice(0, cut)}.${padded.slice(cut)}`;
}

function formatFixedQuote(n: number): string {
  return n.toFixed(4);
}

function toIdOut(id: string): number | string {
  const n = Number(id);
  return Number.isFinite(n) && String(n) === id ? n : id;
}
