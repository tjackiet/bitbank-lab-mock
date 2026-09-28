/**
 * 公式ドキュメントの応答表から書き写したフィールド定義。
 *
 * 出典は bitbankinc/bitbank-api-docs のコミット 0badd68019646171826625b074cfef4235c3e713
 * （`docs/fidelity.md` の「出典」節が固定する版）の `rest-api.md`。
 *
 * **実装（`src/routes/format.ts` の `OrderShape` / `TradeShape`）からは導かない。**
 * 期待値を実装の型から組み立てると、実装が公式から外れたときにテストも一緒に外れる。
 * 各定数のコメントに応答表の該当行をそのまま引用する。
 */

/** 値の型検査。公式の Type 欄をそのまま述語にする。 */
export type FieldCheck = (v: unknown) => boolean;

const isString: FieldCheck = (v) => typeof v === "string";
const isNumber: FieldCheck = (v) => typeof v === "number" && Number.isFinite(v);
const isBoolean: FieldCheck = (v) => typeof v === "boolean";
const isNumberOrNull: FieldCheck = (v) => v === null || isNumber(v);
const isStringOrNull: FieldCheck = (v) => v === null || isString(v);

/**
 * `Fetch order information` の応答表のうち、条件なしで必ず出るフィールド。
 *
 * ```
 * order_id | number | order id
 * pair | string | pair enum
 * side | string | `buy` or `sell`
 * type | string | one of `limit`, `market`, `stop`, ...
 * start_amount | string | null | order qty when placed
 * remaining_amount | string | null | qty not executed
 * executed_amount| string | qty executed
 * user_cancelable | boolean | whether cancelable order or not
 * average_price | string | avg executed price
 * ordered_at | number | ordered at unix timestamp (milliseconds)
 * expire_at | number | null | expiration time in unix timestamp (milliseconds)
 * status | string | status enum: ...
 * ```
 *
 * 同じ表を `Create new order` / `Cancel order` も持ち、`Fetch multiple orders` と
 * `Fetch active orders` は "list of object same as Fetch order information response"
 * と定義する。つまり 5 節すべてがこの集合を共有する。
 */
export const OFFICIAL_ORDER_FIELDS: Record<string, FieldCheck> = {
  order_id: isNumber,
  pair: isString,
  side: isString,
  type: isString,
  start_amount: isStringOrNull,
  remaining_amount: isStringOrNull,
  executed_amount: isString,
  user_cancelable: isBoolean,
  average_price: isString,
  ordered_at: isNumber,
  expire_at: isNumberOrNull,
  status: isString,
};

/**
 * 条件付きで出るフィールド。条件は公式の Description 欄をそのまま写す。
 *
 * ```
 * price | string | undefined | order price (present only if type = `limit` or `stop_limit`)
 * post_only | boolean | undefined | whether Post Only or not (present only if type = `limit`)
 * canceled_at | number | canceled at unix timestamp (milliseconds)   ← Cancel order の表のみ
 * ```
 *
 * `canceled_at` を応答表に持つのは `Cancel order` だけで、`Fetch order information` の
 * 表には無い。本モックの扱いは `docs/fidelity.md` の「注文の `canceled_at`」節を参照。
 */
export const OFFICIAL_ORDER_CONDITIONAL_FIELDS: Record<string, FieldCheck> = {
  price: isString,
  post_only: isBoolean,
  canceled_at: isNumber,
};

/**
 * 公式の応答表にはあるが、本モックが機能自体を実装しないので常に出さないフィールド。
 * 省略は欠陥ではない（README の「非目標（Plan A）」）。テストは「出ていないこと」を固定する。
 *
 * ```
 * position_side | string | undefined | `long` or `short`(only for margin trading)
 * triggered_at | number | undefined | ... (present only if type = `stop`, `stop_limit`, ...)
 * trigger_price | string | undefined | trigger price (present only if type = `stop`, ...)
 * ```
 */
export const UNIMPLEMENTED_ORDER_FIELDS = ["position_side", "triggered_at", "trigger_price"];

/**
 * status enum は節ごとに集合が違うので、節ごとに別の定数として写す。
 * 広い方（7 値）で全経路を検査すると、`REJECTED` を返してはいけない経路で
 * `REJECTED` が素通りする。
 *
 * `Fetch order information`（`Fetch multiple orders` / `Fetch active orders` も
 * この節を参照する）。`REJECTED` を含む 7 値。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`, `REJECTED`
 * ```
 *
 * **写したのは英語版（`rest-api.md:310`）で、日本語版の同じ節は 6 値である**
 * （`rest-api_JP.md:318` に `REJECTED` が無い）。**`REJECTED` が英語版にしか無いという
 * ことではない**——日本語版は `Create new order` の側に載せている（`rest-api_JP.md:409`）。
 * 節ごとの列挙の完全性が公式文書の中で揺れているので、**どちらかの言語版を「採用した」と
 * 読まないこと**（`docs/fidelity.md` の「注文状態」節に 3 節 × 2 言語の表がある）。
 */
export const OFFICIAL_FETCH_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
  "REJECTED",
];

/**
 * `Create new order`。`REJECTED` を含まない 6 値。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`
 * ```
 *
 * **ここも英語版（`rest-api.md:401`）で、日本語版の同じ節は `REJECTED` を含む 7 値である**
 * （`rest-api_JP.md:409`）。上の `OFFICIAL_FETCH_ORDER_STATUSES` とは**揺れの向きが逆**で、
 * どちらが正かは実測していない（`docs/fidelity.md` の「注文状態」節）。
 */
export const OFFICIAL_CREATE_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
];

/**
 * `Cancel order`（`Cancel multiple orders` もこの節を参照する）。`REJECTED` を
 * 含まない 6 値。`Create new order` と同じ並びだが、別の節の別の表なので
 * 独立に写す（一方だけが変わりうる）。
 *
 * **この節だけは英日で揃っている**——`REJECTED` は `rest-api.md:487` にも
 * `rest-api_JP.md:495` にも無い（`docs/fidelity.md` の「注文状態」節）。
 *
 * ```
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`
 * ```
 */
export const OFFICIAL_CANCEL_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
];

/**
 * `Fetch trade history` の応答表。`position_side` / `profit_loss` / `interest` を除く全行。
 *
 * ```
 * trade_id | number | trade id
 * pair | string | pair enum
 * order_id | number | order id
 * side | string | `buy` or `sell`
 * type | string | one of `limit`, `market`, `stop`, ...
 * amount | string | amount
 * price | string | order price
 * maker_taker | string | maker or taker
 * fee_amount_base | string | base asset fee amount
 * fee_amount_quote | string | quote asset fee amount
 * fee_occurred_amount_quote | string | quote fee occurred amount which taken later.
 *                                      In case of spot trading, this value is same as fee_amount_quote.
 * executed_at | number | order executed at unix timestamp (milliseconds)
 * ```
 *
 * `fee_occurred_amount_quote` の Type 欄は `string` で、`| undefined` が付かない。
 * 応答例の JSON には無いが、型が必須である以上こちらを正とする。
 */
export const OFFICIAL_TRADE_FIELDS: Record<string, FieldCheck> = {
  trade_id: isNumber,
  pair: isString,
  order_id: isNumber,
  side: isString,
  type: isString,
  amount: isString,
  price: isString,
  maker_taker: isString,
  fee_amount_base: isString,
  fee_amount_quote: isString,
  fee_occurred_amount_quote: isString,
  executed_at: isNumber,
};

/**
 * 信用取引を実装しないので常に出さないフィールド。
 *
 * ```
 * position_side | string | undefined | `long` or `short`(only for margin trading)
 * profit_loss | string | undefined | realized profit and loss
 * interest | string | undefined | interest
 * ```
 */
export const UNIMPLEMENTED_TRADE_FIELDS = ["position_side", "profit_loss", "interest"];

/** 本モックが返す注文の type。公式の enum のうち Plan A で実装する 2 値。 */
export const IMPLEMENTED_ORDER_TYPES = ["limit", "market"];

type ShapeResult = { keys: string[]; badTypes: string[] };

/**
 * キー集合と各値の型をまとめて返す。`expect(...).toEqual(...)` の左辺に置くことで、
 * 欠落・余剰・型違いのどれが起きても差分に出る。`toMatchObject` は使わない
 * （ドキュメントに無いキーが素通りするため）。
 */
function shapeOf(actual: Record<string, unknown>, spec: Record<string, FieldCheck>): ShapeResult {
  const badTypes: string[] = [];
  for (const [name, check] of Object.entries(spec)) {
    if (name in actual && !check(actual[name])) {
      badTypes.push(`${name}=${JSON.stringify(actual[name])}`);
    }
  }
  return { keys: Object.keys(actual).sort(), badTypes: badTypes.sort() };
}

/** 注文の比較結果。キー集合と型に加えて `type` の値そのものを持つ。 */
type OrderShapeResult = ShapeResult & { type: unknown };

/**
 * 注文オブジェクトの期待形。`type` と「取消済みか」から、公式の条件どおりに
 * 出るはずのキー集合を組み立てる。
 *
 * `type` の値も比較対象に入れる。キー集合だけを見ると、応答が指値・成行の
 * 取り違えを起こしていても、キーの数が合っていれば通ってしまうため。
 */
export function orderShape(
  actual: Record<string, unknown>,
  expected: { type: "limit" | "market"; canceled: boolean },
): { actual: OrderShapeResult; expected: OrderShapeResult } {
  const keys = Object.keys(OFFICIAL_ORDER_FIELDS);
  // price: type = limit のみ（stop_limit は未実装）。post_only: type = limit のみ。
  if (expected.type === "limit") keys.push("price", "post_only");
  // canceled_at: 公式の応答表に持つのは Cancel order だけ。モックは取消時のみ出す。
  if (expected.canceled) keys.push("canceled_at");
  return {
    actual: {
      type: actual.type,
      ...shapeOf(actual, { ...OFFICIAL_ORDER_FIELDS, ...OFFICIAL_ORDER_CONDITIONAL_FIELDS }),
    },
    expected: { type: expected.type, keys: keys.sort(), badTypes: [] },
  };
}

/** 約定オブジェクトの期待形。条件付きのフィールドは無い。 */
export function tradeShape(actual: Record<string, unknown>): {
  actual: ShapeResult;
  expected: ShapeResult;
} {
  return {
    actual: shapeOf(actual, OFFICIAL_TRADE_FIELDS),
    expected: { keys: Object.keys(OFFICIAL_TRADE_FIELDS).sort(), badTypes: [] },
  };
}

// ---------------------------------------------------------------------------
// private stream（`private-stream.md`、同じコミット 0badd680）
//
// REST の表とは**別の節の別の表**なので、形が同じでも独立に写す（一方だけが変わりうる）。
// ---------------------------------------------------------------------------

/**
 * `GET /v1/user/subscribe`（`rest-api.md:1790-1793`、"Get channel and token for private stream"）。
 *
 * ```
 * pubnub_channel | string | channel name
 * pubnub_token | string | token
 * ```
 */
export const OFFICIAL_SUBSCRIBE_FIELDS: Record<string, FieldCheck> = {
  pubnub_channel: isString,
  pubnub_token: isString,
};

/**
 * `method: spot_order_new` のフィールド表（`private-stream.md:115-136`）。`spot_order` は
 * 「内容は `spot_order_new` と同一」（`private-stream.md:176`）なので同じ表を使う。
 *
 * **写したのは英語版で、日本語版（`private-stream_JP.md:116-137`）とは 5 行の型が違う。**
 * どちらかを正には選ばない（`docs/fidelity.md` の「private stream の注文ペイロード」に表がある）。
 *
 * ```
 * canceled_at      EN number          JP number | undefined
 * price            EN string          JP string | undefined（type = limit / stop_limit のときだけ）
 * remaining_amount EN string | null   JP string
 * start_amount     EN string | null   JP string
 * expire_at        EN number | null   JP number
 * ```
 *
 * ```
 * average_price | string | avg executed price
 * canceled_at | number | canceled at unix timestamp (milliseconds)
 * executed_amount | string | qty executed
 * executed_at | number | order executed at unix timestamp (milliseconds)
 * order_id | number | order ID
 * ordered_at | number | ordered at unix timestamp (milliseconds)
 * pair | string | pair enum: [pair list](pairs.md)
 * price | string | order price
 * trigger_price | string \| undefined | trigger price(present only if type = `stop`, ...)
 * remaining_amount | string \| null | qty not executed
 * position_side | string \| undefined | `long` or `short`(only for margin trading)
 * side | string | `buy` or `sell`
 * start_amount | string \| null | order qty when placed
 * status | string | status enum: `INACTIVE`, `UNFILLED`, `PARTIALLY_FILLED`, `FULLY_FILLED`, `CANCELED_UNFILLED`, `CANCELED_PARTIALLY_FILLED`
 * type | string | one of `limit`, `market`, `stop`, `stop_limit`, `take_profit`, `stop_loss`, `losscut`
 * expire_at | number \| null | expiration time in unix timestamp (milliseconds)
 * triggered_at | number \| undefined | triggered at ... (present only if type = `stop`, ...)
 * post_only | boolean \| undefined | whether Post Only or not (present only if type = `limit`)
 * user_cancelable | boolean | User cancelable
 * is_just_triggered | boolean | Just triggered
 * ```
 *
 * ここに写すのは**本モックが常に出す行**。`executed_at` は英日どちらの表も `number` なので
 * 常に出す（約定が無ければ `0`）。`price` / `canceled_at` は英語版の表では条件が付かないが、
 * **日本語版の表と REST の表（英日とも）が条件付きと書くので、本モックは値があるときだけ出す**
 * （`price` は指値だけ、`canceled_at` は取消済みだけ）。その 2 つと `post_only` は下の
 * `OFFICIAL_STREAM_ORDER_CONDITIONAL_FIELDS` に置き、出る条件は `streamOrderShape()` が持つ。
 * `expire_at` は英語版と REST の `number | null` を採る（日本語版の stream の表だけが `null` を許さない）。
 */
export const OFFICIAL_STREAM_ORDER_FIELDS: Record<string, FieldCheck> = {
  average_price: isString,
  executed_amount: isString,
  order_id: isNumber,
  ordered_at: isNumber,
  pair: isString,
  remaining_amount: isStringOrNull,
  side: isString,
  start_amount: isStringOrNull,
  status: isString,
  type: isString,
  expire_at: isNumberOrNull,
  user_cancelable: isBoolean,
  executed_at: isNumber,
  is_just_triggered: isBoolean,
};

/** 上の表のうち、本モックが条件付きで出す行（条件は `streamOrderShape()`）。 */
export const OFFICIAL_STREAM_ORDER_CONDITIONAL_FIELDS: Record<string, FieldCheck> = {
  canceled_at: isNumber,
  price: isString,
  post_only: isBoolean,
};

/** 上の表の status enum（`private-stream.md:130`）。`REJECTED` を含まない 6 値。 */
export const OFFICIAL_STREAM_ORDER_STATUSES = [
  "INACTIVE",
  "UNFILLED",
  "PARTIALLY_FILLED",
  "FULLY_FILLED",
  "CANCELED_UNFILLED",
  "CANCELED_PARTIALLY_FILLED",
];

/**
 * `method: spot_trade` のフィールド表（`private-stream.md:245-261`）。`position_side` /
 * `profit_loss` / `interest`（信用取引の項目）を除く全行。
 *
 * **除いた 3 行は英日で型が違う**——英語版は `| undefined`、日本語版（`private-stream_JP.md:257,261-262`）は
 * `| null`。本モックは REST の表（英日とも `| undefined`）と英語版に揃えてキーごと出さない
 * （`docs/fidelity.md` の「信用取引・逆指値の項目」）。
 *
 * ```
 * amount | string | executed amount
 * executed_at | number | order executed at unix timestamp (milliseconds)
 * fee_amount_base | string | base asset fee amount
 * fee_amount_quote | string | quote asset fee amount
 * fee_occurred_amount_quote | string | Quote fee occurred. ...
 * maker_taker | string | maker or taker
 * order_id | number | order ID
 * pair | string | pair enum: [pair list](pairs.md)
 * price | string | order price
 * side | string | `buy` or `sell`
 * trade_id | number | trade ID
 * type | string | one of `limit`, `market`, ...
 * ```
 */
export const OFFICIAL_SPOT_TRADE_FIELDS: Record<string, FieldCheck> = {
  amount: isString,
  executed_at: isNumber,
  fee_amount_base: isString,
  fee_amount_quote: isString,
  fee_occurred_amount_quote: isString,
  maker_taker: isString,
  order_id: isNumber,
  pair: isString,
  price: isString,
  side: isString,
  trade_id: isNumber,
  type: isString,
};

/**
 * `method: asset_update` の**フィールド表**（`private-stream.md:80-87`）。snake_case。
 *
 * ```
 * asset | string  | Asset name: [Asset list](assets.md)
 * amount_precision | number | Precision
 * free_amount | string | Available amount
 * locked_amount | string | Locked amount
 * onhand_amount | string | On-hand amount
 * withdrawing_amount | string | Withdrawing amount
 * ```
 *
 * **同じ節の JSON 応答例は camelCase で、表と食い違う**（下の定数。`docs/fidelity.md` の
 * 「private stream の `asset_update` のキー」）。どちらかを正に選ばず、両方を写す。
 */
export const OFFICIAL_ASSET_UPDATE_SNAKE_FIELDS: Record<string, FieldCheck> = {
  asset: isString,
  amount_precision: isNumber,
  free_amount: isString,
  locked_amount: isString,
  onhand_amount: isString,
  withdrawing_amount: isString,
};

/**
 * `method: asset_update` の**JSON 応答例**（`private-stream.md:89-107`）。camelCase。
 *
 * ```json
 * "asset": "string",
 * "amountPrecision": 0,
 * "freeAmount": "string",
 * "lockedAmount": "string",
 * "onhandAmount": "string",
 * "withdrawingAmount": "string"
 * ```
 */
export const OFFICIAL_ASSET_UPDATE_CAMEL_FIELDS: Record<string, FieldCheck> = {
  asset: isString,
  amountPrecision: isNumber,
  freeAmount: isString,
  lockedAmount: isString,
  onhandAmount: isString,
  withdrawingAmount: isString,
};

/**
 * stream の注文オブジェクトの期待形。REST の `orderShape()` と同じく、`type` と「取消済みか」
 * から出るはずのキー集合を組み立てる。
 */
export function streamOrderShape(
  actual: Record<string, unknown>,
  expected: { type: "limit" | "market"; canceled: boolean },
): { actual: OrderShapeResult; expected: OrderShapeResult } {
  const keys = Object.keys(OFFICIAL_STREAM_ORDER_FIELDS);
  if (expected.type === "limit") keys.push("price", "post_only");
  if (expected.canceled) keys.push("canceled_at");
  return {
    actual: {
      type: actual.type,
      ...shapeOf(actual, {
        ...OFFICIAL_STREAM_ORDER_FIELDS,
        ...OFFICIAL_STREAM_ORDER_CONDITIONAL_FIELDS,
      }),
    },
    expected: { type: expected.type, keys: keys.sort(), badTypes: [] },
  };
}

/** 条件付きのフィールドを持たない表どうしの比較（`spot_trade` / `asset_update` / subscribe）。 */
export function flatShape(
  actual: Record<string, unknown>,
  spec: Record<string, FieldCheck>,
): { actual: ShapeResult; expected: ShapeResult } {
  return {
    actual: shapeOf(actual, spec),
    expected: { keys: Object.keys(spec).sort(), badTypes: [] },
  };
}
