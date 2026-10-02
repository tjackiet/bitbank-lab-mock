import { type ChildProcess, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  freePort,
  requestJson,
  spawnServer,
  waitForExit,
  waitUntilListening,
} from "../server-process.ts";

/**
 * `examples/scenario-mcp-lab.mjs` の、**確認を始める前に止まる経路だけ**を流す。
 *
 * 本体（MCP → モックの通し）は MCP の checkout（別リポジトリ）が無いと動かないので、ここでは
 * 流さない。手で流す手順は README の「起動」節にある。ここが見るのは、前提が欠けたときに
 * わかる言葉で終了コード 2 で止まり、**それまでに MCP を起こさず、モックの状態も変えない**こと。
 *
 * スクリプトはモックの応答に乗って前提を判定している（`GET /_control/state` の `clock.mode`、
 * control 無効時の 404）。モック側の応答の形が変わると、スクリプトは仮想時計のモックにも
 * 「仮想時計で動いていません」と言って止まるようになるが、MCP の checkout を持つ人が流すまで
 * 誰も気付かない。前提の判定が通る側（最後のテスト）まで流しておくのはそのためである。
 *
 * MCP の代わりには、起動してすぐ終わる偽物（`node_modules/.bin/tsx` の位置に置くシェル）を使う。
 * 外へ要求は出ない（相手はこのテストが起こしたループバックのモックだけ）。
 */

const SCRIPT = "examples/scenario-mcp-lab.mjs";

/**
 * グローバルの WebSocket が要る（スクリプトは無ければ 2 で止まる）。Node.js 20 では
 * WebSocket の判定より後ろの前提に届かないので、そこから先のテストは飛ばす。
 */
const hasWebSocket = typeof (globalThis as { WebSocket?: unknown }).WebSocket === "function";

/** スクリプトを流して、終了コードと出力を返す。 */
function runScript(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT], {
      env: {
        ...process.env,
        // 開発者の端末に export されていても揺れないよう、スクリプトが読むものは毎回置く。
        // `undefined` を渡すと Node は envp から外す。
        MCP_LAB_DIR: undefined,
        BITBANK_MOCK_URL: undefined,
        MCP_LAB_API_KEY: undefined,
        MCP_LAB_API_SECRET: undefined,
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (c: string) => {
      stdout += c;
    });
    child.stderr?.on("data", (c: string) => {
      stderr += c;
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

/** 失敗したときに読めるよう、出力ごと終了コードを見る。 */
function expectStopped(r: { code: number | null; stdout: string; stderr: string }, code: number) {
  expect(r.code, `--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`).toBe(code);
}

/**
 * 前提の検査を通る形だけをそろえた MCP の checkout。`node_modules/.bin/tsx` は
 * 標準エラーに 1 行書いてすぐ終わるシェルで、MCP の代わりに起こされる。
 */
async function fakeMcpCheckout(dir: string): Promise<string> {
  const root = join(dir, "mcp");
  await mkdir(join(root, "lab"), { recursive: true });
  await mkdir(join(root, "node_modules/.bin"), { recursive: true });
  await writeFile(join(root, "lab/start.ts"), "");
  const tsx = join(root, "node_modules/.bin/tsx");
  await writeFile(tsx, '#!/bin/sh\necho "fake mcp: refused" >&2\nexit 3\n');
  await chmod(tsx, 0o755);
  return root;
}

/** 発注を 1 本入れる。止まった後に、状態が変わっていないこと（reset されていないこと）を見る印。 */
async function placeOrder(port: number): Promise<void> {
  const res = await requestJson(port, "POST", "/v1/user/spot/order", {
    pair: "btc_jpy",
    amount: "0.001",
    price: "5000000",
    side: "buy",
    type: "limit",
  });
  expect(res.body).toMatchObject({ success: 1 });
}

/** モックの注文の本数。 */
async function orderCount(port: number): Promise<number> {
  const res = await requestJson(port, "GET", "/_control/state");
  return (res.body as { orders: unknown[] }).orders.length;
}

// Windows では偽の MCP（シェル）を起こせない。CI は ubuntu で、スクリプトの利用者も POSIX を前提にしている。
describe.skipIf(process.platform === "win32")("examples/scenario-mcp-lab.mjs: 前提の検査", () => {
  let dir: string | null = null;
  let child: ChildProcess | null = null;

  afterEach(async () => {
    if (child && child.exitCode === null) {
      child.kill("SIGKILL");
      await waitForExit(child);
    }
    child = null;
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = null;
  });

  /** モックを起こし、ポートを返す。`env` は既定の配線に足すもの。 */
  async function startMock(env: NodeJS.ProcessEnv): Promise<number> {
    dir ??= await mkdtemp(join(tmpdir(), "bitbank-mock-mcp-lab-"));
    const port = await freePort();
    child = spawnServer({
      BITBANK_MOCK_STATE_PATH: join(dir, "state.json"),
      BITBANK_MOCK_PORT: String(port),
      BITBANK_MOCK_HOST: "127.0.0.1",
      // 開発者の環境に export されていても揺れないよう、継いだ値を落としてから足す。
      BITBANK_MOCK_CONTROL: undefined,
      BITBANK_MOCK_CLOCK: undefined,
      BITBANK_MOCK_FILL_MODE: undefined,
      ...env,
    });
    await waitUntilListening(child);
    return port;
  }

  it("MCP_LAB_DIR が無ければ 2 で止まる", async () => {
    const r = await runScript({});
    expectStopped(r, 2);
    expect(r.stderr).toContain(
      "MCP_LAB_DIR に bitbank-lab-mcp の checkout の場所を指定してください",
    );
  });

  it("ループバック以外の BITBANK_MOCK_URL は叩かずに 2 で止まる", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-mcp-lab-"));
    // 127.0.0.2 はループバックの範囲だが、MCP の起動口が受け付ける 3 つには入らない。
    // 判定が壊れても要求はこの機械の外へ出ず、「繋がりません」で止まってこのテストが落ちる。
    const r = await runScript({
      MCP_LAB_DIR: await fakeMcpCheckout(dir),
      BITBANK_MOCK_URL: "http://127.0.0.2:14000",
    });
    expectStopped(r, 2);
    expect(r.stderr).toContain("BITBANK_MOCK_URL はループバック");
  });

  it("MCP の checkout に lab/start.ts が無ければ、66d9a69 以降と npm ci を案内して 2 で止まる", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-mcp-lab-"));
    const r = await runScript({ MCP_LAB_DIR: dir });
    expectStopped(r, 2);
    expect(r.stderr).toContain("lab/start.ts がありません");
    expect(r.stderr).toContain("66d9a69 以降にして npm ci してください");
  });

  it.skipIf(!hasWebSocket)(
    "モックの /_control/ が無効なら 2 で止まる",
    async () => {
      const port = await startMock({});
      const r = await runScript({
        MCP_LAB_DIR: await fakeMcpCheckout(dir!),
        BITBANK_MOCK_URL: `http://127.0.0.1:${port}`,
      });
      expectStopped(r, 2);
      expect(r.stderr).toContain("モックの /_control/ が無効です");
    },
    40_000,
  );

  it.skipIf(!hasWebSocket)(
    "実時刻のモックなら reset せずに 2 で止まる",
    async () => {
      const port = await startMock({ BITBANK_MOCK_CONTROL: "1" });
      await placeOrder(port);
      const r = await runScript({
        MCP_LAB_DIR: await fakeMcpCheckout(dir!),
        BITBANK_MOCK_URL: `http://127.0.0.1:${port}`,
      });
      expectStopped(r, 2);
      expect(r.stderr).toContain("モックが仮想時計で動いていません");
      expect(await orderCount(port)).toBe(1);
    },
    40_000,
  );

  it.skipIf(!hasWebSocket)(
    "前提がそろえば reset して MCP を起こし、起動の段階で終わった MCP は 2 で報告する",
    async () => {
      const port = await startMock({ BITBANK_MOCK_CONTROL: "1", BITBANK_MOCK_CLOCK: "virtual" });
      await placeOrder(port);
      const r = await runScript({
        MCP_LAB_DIR: await fakeMcpCheckout(dir!),
        BITBANK_MOCK_URL: `http://127.0.0.1:${port}`,
      });
      expectStopped(r, 2);
      // 前提の検査を抜けて偽の MCP まで届いた。MCP の標準エラーも添えて出す。
      expect(r.stderr).toContain("MCP が終了しました（code=3");
      expect(r.stderr).toContain("fake mcp: refused");
      // 確認は 1 つも始めていない（始めていれば 2 ではなく 1 で終わる）。
      expect(r.stdout).not.toMatch(/^(OK|NG) /m);
      expect(await orderCount(port)).toBe(0);
    },
    40_000,
  );
});
