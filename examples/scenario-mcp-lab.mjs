// MCP の研究用起動口（bitbank-lab-mcp の lab/start.ts）からモックまでを通す確認。挙動確認・検証用。
//
// MCP を子プロセスとして起こし、MCP クライアントとして stdio の JSON-RPC で話す。MCP の private API の
// 接続先は --private-api-origin でこのモックへ向けるので、ツールを呼ぶと MCP → モックの順に通る。
// 見るのは、確認を経た発注と取消、確認で decline すると発注されないこと、部分約定、仮想時計の時刻、
// 応答不明（no_response）、429 からの再試行、private stream。
//
// **MCP の確認（elicitation）には、このスクリプトが人の代わりに自動で応える。** MCP は発注と取消の前に
// 確認への応答を必須にしていて、応えるのはクライアント側の役目だから。確認の扱いの正は MCP の lab/README.md。
//
// 前提（欠けていれば、確認を始める前に終了コード 2 で止まる）:
// - モックを BITBANK_MOCK_CONTROL=1 BITBANK_MOCK_CLOCK=virtual で起動しておく
// - MCP（tjackiet/bitbank-lab-mcp）の checkout を 66d9a69 以降にして npm ci しておく
// - Node.js 22 以上（グローバルの WebSocket を使う。MCP も engines.node が >=22）
// 先頭で POST /_control/reset を叩き、モックの状態を捨てる。
//
// 環境変数:
// - MCP_LAB_DIR（必須）: MCP の checkout の場所
// - BITBANK_MOCK_URL: 叩き先（既定 http://127.0.0.1:14000）。ループバックだけを受け付ける
// - MCP_LAB_API_KEY / MCP_LAB_API_SECRET: MCP に渡すキーとシークレット（既定 lab-key / lab-secret）。
//   モックに認証ヘッダを検証させるときは、モックの BITBANK_MOCK_API_KEY / BITBANK_MOCK_API_SECRET と同じ値にする。
//   **シェルの BITBANK_API_KEY / BITBANK_API_SECRET は読まない。** 本番に MCP を繋いでいると本物の鍵が
//   入っていることがあるので、MCP には常にこの 2 つで上書きして渡す。
//
// 終了コード: 全部 OK なら 0。NG があれば 1（1 や途中で止まったときも 1）。
// 指定や前提が足りず確認を始めなかったら 2。
//
// MCP 66d9a69 に依存するところ:
// - 判定は表示文言ではなく、MCP の structuredContent（ok と data）とモックの /_control/state で見る。
//   表示文言は、行末の「—」の後に参考として出すだけ
// - structuredContent の形に依存する項目: 1・8（data.assets）、3（data.orders）、4（data.order.status）、
//   4'（data.trades）、7（ok）
// - 確認の形に依存する項目: 2・5・6（elicitation/create が届き、{ confirmed: true } で accept する）
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const RAW_URL = process.env.BITBANK_MOCK_URL || "http://127.0.0.1:14000";
const API_KEY = process.env.MCP_LAB_API_KEY || "lab-key";
const API_SECRET = process.env.MCP_LAB_API_SECRET || "lab-secret";

const INITIAL_JPY = 1_000_000;
const CLOCK_START = "2026-09-01T00:00:00.000Z";
const FILL_AMOUNT = 0.0004;
const ORDER = { pair: "btc_jpy", amount: "0.001", price: "5000000", side: "buy", type: "limit" };
const TIMEOUT_MS = 90_000;

/**
 * 出力を書き切ってから終了する。macOS ではパイプへの書き込みが非同期で、
 * いきなり process.exit() すると `| tee` などで出力が切れうる。
 */
async function exit(code) {
  await new Promise((r) => process.stdout.write("", r));
  await new Promise((r) => process.stderr.write("", r));
  process.exit(code);
}

/** 指定や前提が足りないので、確認を始めずに止める。 */
async function usage(message) {
  console.error(message);
  await exit(2);
}

// ---- 前提（ここで止まるときは、モックの状態を変えず MCP も起こさない） ----

if (!process.env.MCP_LAB_DIR) {
  await usage("MCP_LAB_DIR に bitbank-lab-mcp の checkout の場所を指定してください");
}
// spawn は cwd を移ってから実行ファイルを探すので、相対パスのままだと二重に解決される。
const MCP_DIR = resolve(process.env.MCP_LAB_DIR);
const TSX = join(MCP_DIR, "node_modules/.bin/tsx");
const START = join(MCP_DIR, "lab/start.ts");

let url;
try {
  url = new URL(RAW_URL);
} catch {
  await usage(`BITBANK_MOCK_URL を URL として読めません: ${RAW_URL}`);
}
if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
  await usage("BITBANK_MOCK_URL はループバック（127.0.0.1 / localhost / [::1]）だけを受け付けます");
}
// MCP の起動口は scheme・ホスト・ポートだけを受け付ける（末尾の / も不可）ので、origin に揃える。
const BASE = url.origin;

for (const file of [START, TSX]) {
  if (!existsSync(file)) {
    await usage(`${file} がありません。MCP の checkout を 66d9a69 以降にして npm ci してください`);
  }
}

if (typeof WebSocket !== "function") {
  await usage(
    `グローバルの WebSocket がありません。Node.js 22 以上で流してください（いまは ${process.version}）`,
  );
}

/**
 * `/_control/` を叩き、HTTP ステータスと本文を返す。繋がらなければ status 0 と理由を返す
 * （例外にすると、途中でモックが落ちたときに MCP を片付けずに終わるため）。
 */
async function control(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    return { status: 0, body: `繋がりません（${e.cause?.code ?? e.cause?.message ?? e.message}）` };
  }
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    return { status: res.status, body: text };
  }
}
/** 失敗した `/_control/` の応答を、止まるときの文言にする。 */
const failure = (r) => (r.status === 0 ? r.body : `HTTP ${r.status}: ${JSON.stringify(r.body)}`);

const startHint = "BITBANK_MOCK_CONTROL=1 BITBANK_MOCK_CLOCK=virtual npm run dev";
const initial = await control("GET", "/_control/state");
if (initial.status === 0) {
  await usage(`モック（${BASE}）に${initial.body}。${startHint} で起動してください`);
}
if (initial.status === 404) {
  await usage(`モックの /_control/ が無効です。${startHint} で起動してください`);
}
if (initial.status !== 200) {
  await usage(`GET /_control/state が失敗しました（${failure(initial)}）`);
}
if (initial.body.clock?.mode !== "virtual") {
  await usage(`モックが仮想時計で動いていません。${startHint} で起動してください`);
}

const reset = await control("POST", "/_control/reset", { initialJpy: INITIAL_JPY });
if (reset.status !== 200) {
  await usage(`POST /_control/reset が失敗しました（${failure(reset)}）`);
}

// private stream を購読する。reset は既存の接続を閉じるので、reset の後に繋ぐ。
const events = [];
const ws = new WebSocket(`${BASE.replace(/^http/, "ws")}/_stream/private`);
ws.onmessage = (e) => {
  const m = JSON.parse(e.data).message;
  const p = m.params[0];
  events.push(`${m.method}${p.status ? `:${p.status}` : ""}`);
};
await new Promise((r) => {
  ws.onopen = r;
  ws.onerror = () => usage(`private stream（${BASE}/_stream/private）に繋がりません`);
});
ws.onerror = null;

// ---- MCP を起こし、elicitation を宣言して繋ぐ ----

// 本物の鍵を渡さないよう、キーとシークレットは必ずこのスクリプトの値で上書きする。MCP の checkout に
// .env があっても、MCP の dotenv は既にある環境変数を上書きしないので、ここで渡した値が勝つ。
const mcp = spawn(TSX, [START, `--private-api-origin=${BASE}`], {
  cwd: MCP_DIR,
  env: {
    ...process.env,
    BITBANK_API_KEY: API_KEY,
    BITBANK_API_SECRET: API_SECRET,
    NO_COLOR: "1",
    LOG_LEVEL: "warn",
  },
});
// 文字コードを指定して受ける。Buffer のまま足すと、チャンクの境目で日本語の 1 文字が割れて化ける。
mcp.stdout.setEncoding("utf8");
mcp.stderr.setEncoding("utf8");
let stderr = "";
mcp.stderr.on("data", (d) => {
  stderr += d;
});
// MCP が先に終わると、stdin への書き込みが EPIPE で失敗する。理由は下の exit で出すので、ここでは握る。
mcp.stdin.on("error", () => {});

let initialized = false;
let closing = false;
/** MCP と stream を片付ける。 */
function shutdown() {
  closing = true;
  clearTimeout(timer);
  ws.close();
  mcp.stdin.end();
  mcp.kill();
}
const timer = setTimeout(async () => {
  console.log(`TIMEOUT（${TIMEOUT_MS / 1000} 秒）\nMCP stderr:\n${stderr.slice(0, 2000)}`);
  shutdown();
  await exit(1);
}, TIMEOUT_MS);
mcp.on("error", async (e) => {
  console.error(`MCP を起動できません: ${e.message}`);
  shutdown();
  await exit(2);
});
mcp.on("exit", async (code, signal) => {
  if (closing) return;
  console.error(`MCP が終了しました（code=${code} signal=${signal}）\nMCP stderr:\n${stderr}`);
  shutdown();
  // initialize の前なら、起動の段階で断られた（接続先やキーの指定）ので確認は始めていない。
  await exit(initialized ? 1 : 2);
});

let buf = "";
let lastId = 0;
const waiters = new Map();
/** 確認（elicitation）に何と答えるか。ツールを呼ぶたびに tool() が置く。 */
let answer = "accept";
/** 届いた確認の 1 行目。届いた順。 */
const asked = [];
const write = (o) => mcp.stdin.write(`${JSON.stringify(o)}\n`);
mcp.stdout.on("data", (d) => {
  buf += d;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try {
      m = JSON.parse(line);
    } catch {
      continue;
    }
    if (m.method === "elicitation/create" && m.id !== undefined) {
      asked.push(m.params.message.split("\n")[0]);
      write({
        jsonrpc: "2.0",
        id: m.id,
        result:
          answer === "accept"
            ? { action: "accept", content: { confirmed: true } }
            : { action: "decline" },
      });
    } else if (m.id !== undefined && waiters.has(m.id)) {
      waiters.get(m.id)(m);
      waiters.delete(m.id);
    }
  }
});
const call = (method, params) =>
  new Promise((r) => {
    const id = ++lastId;
    waiters.set(id, r);
    write({ jsonrpc: "2.0", id, method, params });
  });

/**
 * ツールを呼ぶ。返すのは structuredContent（判定に使う）、表示文の 1 行目（参考に出すだけ）、
 * この呼び出しの間に届いた確認（elicitation）。確認には `reply` で答える。
 */
async function tool(name, args, reply = "accept") {
  answer = reply;
  const before = asked.length;
  const r = await call("tools/call", { name, arguments: args });
  const text = r.result?.content?.map((c) => c.text).join("\n") ?? JSON.stringify(r.error);
  return { sc: r.result?.structuredContent, line: text.split("\n")[0], asked: asked.slice(before) };
}

await call("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: { elicitation: {} },
  clientInfo: { name: "scenario-mcp-lab", version: "0" },
});
write({ jsonrpc: "2.0", method: "notifications/initialized" });
initialized = true;

// ---- 確認 ----

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "OK " : "NG "} ${name}${detail ? ` — ${detail}` : ""}`);
}
/** 1 や途中で止まる。以降は発注などの前提が欠けて NG が並ぶだけなので流さない。 */
async function stop(message) {
  console.log(`\n${message}`);
  if (stderr) console.log(`MCP stderr:\n${stderr.slice(0, 1500)}`);
  shutdown();
  await exit(1);
}
/** 以降の確認の前提になる `/_control/` の操作。失敗したら止まる。 */
async function mustControl(method, path, body) {
  const r = await control(method, path, body);
  if (r.status !== 200) {
    await stop(`${method} ${path} が失敗しました（${failure(r)}）`);
  }
  return r.body;
}
/** モックの注文（`/_control/state` の orders）。 */
const mockOrders = async () => (await mustControl("GET", "/_control/state")).orders;
/** MCP の get_my_assets が返す JPY の数量。無ければ undefined。 */
const jpyAmount = (sc) => {
  const jpy = sc?.data?.assets?.find((a) => a.asset === "jpy");
  return jpy === undefined ? undefined : Number(jpy.amount);
};
/** NG のときの手がかり。MCP がエラーを返したなら表示文の 1 行目、そうでなければ判定に使った値。 */
const why = (r, seen) => (r.sc?.ok === true ? seen : `MCP: ${r.line}`);

console.log(`モック: ${BASE} / MCP: ${MCP_DIR}（${mcpRevision()}）\n`);

const clock = await control("POST", "/_control/clock", { lastTickAt: CLOCK_START });
check(
  "0 仮想時計を 2026-09-01 に置ける",
  clock.status === 200 && clock.body.lastTickAt === CLOCK_START,
  JSON.stringify(clock.body),
);

// 1. 資産
let r = await tool("get_my_assets", {});
check(
  "1 get_my_assets が JPY 1,000,000 を返す",
  r.sc?.ok === true && jpyAmount(r.sc) === INITIAL_JPY,
  r.line,
);
if (!results.at(-1).ok) {
  // 認証で断られた（キーやシークレットの違い）などで 1 が通らないと、以降は発注できない
  await stop(
    `1 で止まったため以降を省略します（モック側の注文数: ${(await mockOrders()).length}）`,
  );
}

// 2. 発注（preview → 確認 accept → 実行）
r = await tool("preview_order", ORDER);
let orders = await mockOrders();
const placed = orders[0];
check(
  "2 preview_order → 確認 accept で発注される",
  r.asked.length === 1 && orders.length === 1 && placed?.status === "UNFILLED",
  `確認文: ${r.asked[0] ?? "（届かず）"} / orders=${orders.length}`,
);
check("2' ordered_at が仮想時計の時刻", placed?.orderedAt === CLOCK_START, placed?.orderedAt);
if (placed === undefined) await stop("2 で注文ができなかったため以降を省略します");
// 以降はこの注文を相手にする。MCP のツールは注文 ID を数値で受ける。
const orderId = Number(placed.id);

// 3. 一覧
r = await tool("get_my_orders", { pair: "btc_jpy" });
const listed = r.sc?.data?.orders ?? [];
check(
  "3 get_my_orders に 1 件",
  listed.length === 1 && listed[0].order_id === orderId,
  why(r, `orders=${listed.length}`),
);

// 4. 部分約定（control）→ MCP で照会
await mustControl("POST", "/_control/clock", { advanceMs: 60_000 });
await mustControl("POST", `/_control/orders/${orderId}/fill`, { amount: FILL_AMOUNT });
r = await tool("get_order", { pair: "btc_jpy", order_id: orderId });
check(
  "4 部分約定が MCP から PARTIALLY_FILLED で見える",
  r.sc?.data?.order?.status === "PARTIALLY_FILLED",
  why(r, `status=${r.sc?.data?.order?.status}`),
);
r = await tool("get_my_trade_history", { pair: "btc_jpy" });
const trades = r.sc?.data?.trades ?? [];
check(
  "4' 約定履歴に 1 件",
  trades.length === 1 && trades[0].order_id === orderId && Number(trades[0].amount) === FILL_AMOUNT,
  why(r, `trades=${trades.length} amount=${trades[0]?.amount}`),
);

// 5. 取消（preview_cancel_order → 確認 accept → 実行）
r = await tool("preview_cancel_order", { pair: "btc_jpy", order_id: orderId });
orders = await mockOrders();
const canceled = orders.find((o) => o.id === placed.id);
check(
  "5 preview_cancel_order → 確認 accept で CANCELED_PARTIALLY_FILLED になる",
  r.asked.length === 1 && canceled?.status === "CANCELED_PARTIALLY_FILLED",
  `確認文: ${r.asked[0] ?? "（届かず）"} / ${canceled?.status}`,
);

// 6. 確認で decline すると発注されない
r = await tool("preview_order", ORDER, "decline");
orders = await mockOrders();
// 確認が届いたことまで見る。届く前に断られても注文は増えないので、件数だけでは decline を確かめられない。
check(
  "6 確認 decline では発注されない",
  r.asked.length === 1 && orders.length === 1,
  `確認: ${r.asked.length} 回 / orders=${orders.length}`,
);

// 7. 応答不明（no_response）を MCP 経由で踏む
await mustControl("POST", "/_control/faults", {
  method: "POST",
  path: "/v1/user/spot/order",
  kind: "no_response",
  count: 1,
});
r = await tool("preview_order", ORDER);
orders = await mockOrders();
check(
  "7 応答不明: MCP はエラー、モックには注文が残る",
  r.sc?.ok === false && orders.length === 2,
  `orders=${orders.length} / MCP: ${r.line.slice(0, 80)}`,
);

// 8. 429 を 1 回 → GET は MCP が再試行して通る
const { fault } = await mustControl("POST", "/_control/faults", {
  method: "GET",
  path: "/v1/user/assets",
  kind: "rate_limit",
  count: 1,
});
r = await tool("get_my_assets", {});
const { faults } = await mustControl("GET", "/_control/faults");
const hits = faults.find((f) => f.id === fault.id)?.hits;
check(
  "8 429 の後、GET の再試行で資産が取れる",
  r.sc?.ok === true && Number.isFinite(jpyAmount(r.sc)) && hits === 1,
  why(r, `hits=${hits}`),
);

// 9. private stream
await new Promise((r) => setTimeout(r, 300));
check(
  "9 private stream に発注・約定・取消が流れた",
  ["spot_order_new:UNFILLED", "spot_trade", "spot_order:CANCELED_PARTIALLY_FILLED"].every((x) =>
    events.includes(x),
  ),
  events.join(", "),
);

shutdown();
const ng = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - ng}/${results.length} OK`);
if (ng) console.log(`MCP stderr:\n${stderr.slice(0, 1500)}`);
await exit(ng ? 1 : 0);

/** MCP の checkout の commit（結果を貼るときに、どの MCP で流したかを残すため）。 */
function mcpRevision() {
  try {
    return execFileSync("git", ["-C", MCP_DIR, "rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "commit 不明";
  }
}
