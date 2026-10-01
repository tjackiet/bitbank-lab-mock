#!/usr/bin/env bash
# プラン A のデモ: 指値を発注し、/_control/ で約定させ、残高の三段（発注前 → 拘束 → 約定後）を見る。
# 後半では private stream を切り、繋がらない間も REST の発注と照合が通ることを見る。
#
# 前提: BITBANK_MOCK_CONTROL=1 でモックを起動しておくこと（fillMode の既定が manual になる）。
# 依存は curl だけ。JSON の取り出しは sed / grep で済ませている。
# 期待する状態に届かなければ終了コード 1 で止まる（出力を目で読む前提にしない）。
set -euo pipefail

BASE="${BITBANK_MOCK_URL:-http://127.0.0.1:14000}"

# /_control/ は非ループバックからの要求で X-Control-Token の一致を求める。
control_headers=(-H "content-type: application/json")
if [[ -n "${BITBANK_MOCK_CONTROL_TOKEN:-}" ]]; then
  control_headers+=(-H "X-Control-Token: ${BITBANK_MOCK_CONTROL_TOKEN}")
fi

# 注文の状態を確かめる。**出力するだけでは完了条件の証明にならない。**
# 例えば BITBANK_MOCK_FILL_MODE=market を明示すると、照会が市場足で約定を起こして
# fill の前に FULLY_FILLED になりうる。その場合 /_control/ の fill は 409 を返すが、
# 期待する状態を検査していなければシナリオを果たさないまま終了コード 0 で終わる。
require_status() {
  local json="$1" want="$2" what="$3" got
  got="$(printf '%s' "$json" | sed -E 's/.*"status":"([A-Z_]+)".*/\1/')"
  if [[ "$got" != "$want" ]]; then
    echo "$what: $want を期待しましたが $got でした" >&2
    echo "  応答: $json" >&2
    exit 1
  fi
}

# 応答が期待する形（拡張正規表現）を含むかを確かめる。
require_match() {
  local json="$1" pattern="$2" what="$3"
  if ! printf '%s' "$json" | grep -qE "$pattern"; then
    echo "$what: /$pattern/ を期待しましたが違いました" >&2
    echo "  応答: $json" >&2
    exit 1
  fi
}

# GET の HTTP ステータス（と、渡せば本文の形）を確かめ、本文とステータスを出す。本文の後ろに
# 改行とステータスを足して受け取り、最後の行で分ける（一時ファイルを使わないため）。
require_http() {
  local url="$1" want="$2" what="$3" pattern="${4:-}" resp code body
  resp="$(curl -sS -w '\n%{http_code}' "$url")"
  code="${resp##*$'\n'}"
  body="${resp%$'\n'*}"
  echo "${body}（HTTP ${code}）"
  if [[ "$code" != "$want" ]]; then
    echo "$what: HTTP $want を期待しましたが $code でした" >&2
    exit 1
  fi
  if [[ -n "$pattern" ]]; then
    require_match "$body" "$pattern" "$what"
  fi
}

# jpy 残高の 3 つの値だけを取り出す。assets の応答で jpy は先頭の要素で、
# free_amount / onhand_amount / locked_amount はいずれも withdrawal_fee の
# 入れ子より前にあるので、"asset":"jpy" から最初の } までを切れば足りる。
jpy_balance() {
  curl -sS "$BASE/v1/user/assets" \
    | sed -E 's/.*"asset":"jpy"//; s/\}.*//' \
    | grep -oE '"(free_amount|onhand_amount|locked_amount)":"[^"]*"' \
    | tr '\n' ' '
  echo
}

# 何度流しても同じ値が出るように、毎回まっさらな状態から始める。
echo "reset:"
curl -fsS -X POST "$BASE/_control/reset" "${control_headers[@]}" -d '{}'
echo

echo "発注前の jpy:"
jpy_balance

order_json="$(
  curl -sS -X POST "$BASE/v1/user/spot/order" \
    -H "content-type: application/json" \
    -d '{"pair":"btc_jpy","amount":"0.001","price":"5000000","side":"buy","type":"limit"}'
)"
echo "placed: $order_json"

order_id="$(printf '%s' "$order_json" | sed -E 's/.*"order_id":([0-9]+).*/\1/')"
if [[ ! "$order_id" =~ ^[0-9]+$ ]]; then
  echo "発注に失敗したので中止する: $order_json" >&2
  exit 1
fi

echo "GET order（UNFILLED を期待）:"
before_json="$(curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}")"
echo "$before_json"
require_status "$before_json" "UNFILLED" "約定前の GET order"

# 発注の時点で free が減り、同額が locked に移る。onhand はまだ動かない。
# 拘束額には手数料が含まれる（詳細は docs/fidelity.md の「拘束額」の節）。
echo "発注後の jpy（free が減り locked へ移る）:"
jpy_balance

echo "control fill:"
curl -fsS -X POST "$BASE/_control/orders/${order_id}/fill" \
  "${control_headers[@]}" \
  -d '{}'
echo

echo "GET order（FULLY_FILLED を期待）:"
after_json="$(curl -sS "$BASE/v1/user/spot/order?pair=btc_jpy&order_id=${order_id}")"
echo "$after_json"
require_status "$after_json" "FULLY_FILLED" "約定後の GET order"

# 約定すると locked が解け、onhand が free と同じところまで減る。
echo "約定後の jpy（locked が解け onhand が減る）:"
jpy_balance

# ---- private stream の切断 ----
# 状態を残したまま stream を切り、繋がらない時間を作る（docs/fidelity.md の「private stream の切断」節）。
# WebSocket の接続は curl では張れないので、ここで見るのは口の応答と、切れている間も REST が通ること
# だけである。利用側のクライアントが繋いでいれば、disconnect で close code 1001 が届き、refuse の間の
# 繋ぎ直しは upgrade の前に 503 で断られる。
#
# **refuse を先に入れてから disconnect する。** 逆の順だと、その間に利用側が繋ぎ直せてしまう。
# 切っている間の変化を後から stream で届けたいなら、refuse の前に /_control/stream/hold し、
# 繋ぎ直してから /_control/stream/release する（接続が要るので、ここでは流さない）。
#
# 途中の検査で止まっても受け付けない状態を残さないよう、refuse の前に終了時の後始末を掛けて、
# accept で戻す（同じモックへ繋ぐ他のクライアントが 503 を受け続けないため）。後始末の失敗は
# 握りつぶし、スクリプトの終了コードは変えない。戻せなかったときも、次に流したときの冒頭の
# reset で戻る。
restore_stream() {
  curl -sS -X POST "$BASE/_control/stream/accept" "${control_headers[@]}" -d '{}' \
    >/dev/null 2>&1 || true
}
trap restore_stream EXIT

echo "stream refuse（新しい接続を断る）:"
refuse_json="$(curl -fsS -X POST "$BASE/_control/stream/refuse" "${control_headers[@]}" -d '{}')"
echo "$refuse_json"
require_match "$refuse_json" '"accepting":false' "refuse の応答"

echo "stream disconnect（今の接続をすべて閉じる。繋いでいなければ 0）:"
disconnect_json="$(
  curl -fsS -X POST "$BASE/_control/stream/disconnect" "${control_headers[@]}" -d '{}'
)"
echo "$disconnect_json"
require_match "$disconnect_json" '"closed":[0-9]+' "disconnect の応答"

# 受け付けない間は、upgrade でない GET にも 426 より先に 503 が返るので、curl で確かめられる。
echo "GET /_stream/private（503 STREAM_REFUSED を期待）:"
require_http "$BASE/_stream/private" 503 "切断中の stream" '"error":"STREAM_REFUSED"'

# 切れている間も、発注と照合（orders_info）は通る。利用側はここで状態を確かめる。
cut_json="$(
  curl -sS -X POST "$BASE/v1/user/spot/order" \
    -H "content-type: application/json" \
    -d '{"pair":"btc_jpy","amount":"0.001","price":"4000000","side":"buy","type":"limit"}'
)"
echo "切断中の発注: $cut_json"
cut_id="$(printf '%s' "$cut_json" | sed -E 's/.*"order_id":([0-9]+).*/\1/')"
if [[ ! "$cut_id" =~ ^[0-9]+$ ]]; then
  echo "切断中の発注に失敗したので中止する: $cut_json" >&2
  exit 1
fi

echo "切断中の照合（orders_info。UNFILLED を期待）:"
info_json="$(
  curl -sS -X POST "$BASE/v1/user/spot/orders_info" \
    -H "content-type: application/json" \
    -d "{\"pair\":\"btc_jpy\",\"order_ids\":[${cut_id}]}"
)"
echo "$info_json"
require_status "$info_json" "UNFILLED" "切断中の照合"

echo "stream accept（受け付ける状態に戻す）:"
accept_json="$(curl -fsS -X POST "$BASE/_control/stream/accept" "${control_headers[@]}" -d '{}')"
echo "$accept_json"
require_match "$accept_json" '"accepting":true' "accept の応答"
# 戻せたので、終了時の後始末は外す。
trap - EXIT

# 受け付ける状態に戻ったので、upgrade でない GET は 426 に戻る（WebSocket のクライアントなら繋がる）。
echo "GET /_stream/private（426 を期待）:"
require_http "$BASE/_stream/private" 426 "accept の後の stream"
