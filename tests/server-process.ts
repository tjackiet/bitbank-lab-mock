import { type ChildProcess, spawn } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";

/**
 * 実プロセスとしてサーバを起こすための道具。`inject()` では見えないもの——起動引数、
 * 状態ファイルの排他、実際に listen したポート、curl から叩ける口、再起動をまたぐ状態——を
 * 見るテストが使う。
 *
 * `tests/index.test.ts`（配線）と `tests/scenarios/example-script.test.ts`（例のスクリプト）の
 * 2 箇所から使う。写すと、下の `--import` の理由のような**外すと壊れる注意書き**が
 * 片方だけ残って腐るので 1 箇所に置く。
 */

export const STARTUP_TIMEOUT_MS = 20_000;

/**
 * `npx tsx` や `node_modules/.bin/tsx` ではなく `node --import tsx` で起こす。
 *
 * 前者はラッパが子の node を産むので、`child.pid` はラッパのもので、`SIGKILL` は子へ
 * 届かない。テストが途中で落ちたときに**サーバがポートとロックを握ったまま孤児として
 * 残る**（実際に残り、後続の実行を壊した）。`--import` なら 1 プロセスなので、
 * `child.pid` がそのままサーバの pid になり、後始末も確実に効く。
 */
export function spawnServer(env: NodeJS.ProcessEnv, args: string[] = []): ChildProcess {
  const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", ...args], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  // 標準エラーは `pipe` にしたまま誰も読まないと、出力がバッファを埋めた時点で
  // 子が write で止まる。下の `collectStderr()` が必ず読み出す。
  child.stderr?.setEncoding("utf8");
  return child;
}

/** 子プロセスが標準エラーへ出したものを集める。読み捨てずに溜めるので詰まらない。 */
export function collectStderr(child: ChildProcess): () => string {
  let text = "";
  child.stderr?.on("data", (chunk: string) => {
    text += chunk;
  });
  return () => text;
}

/** 空いている TCP ポートを 1 つ借りる。固定ポートは他の実行とぶつかる。 */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("ポートを取れなかった")));
        return;
      }
      const { port } = address;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * fastify の listen ログが出るまで待つ。
 *
 * HTTP を叩いて待つと、**別のプロセスが同じポートで応答しているだけ**でも先へ進む
 * （固定ポートだった頃に実際に起きた）。自分が起こしたプロセスの標準出力で待てば取り違えない。
 */
export function waitUntilListening(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    const timer = setTimeout(() => reject(new Error(`起動しなかった: ${out}`)), STARTUP_TIMEOUT_MS);
    const done = (e?: Error) => {
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      if (e) reject(e);
      else resolve(out);
    };
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      if (out.includes("Server listening at")) done();
    };
    child.stdout?.on("data", onData);
    child.once("exit", (code) => done(new Error(`起動前に終了した (code ${code}): ${out}`)));
  });
}

/** 子プロセスが終わるまで待つ。既に終わっていれば即座に解決する。 */
export function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

/**
 * 起こしたサーバへ JSON の要求を 1 本送り、ステータスと本文を返す。
 *
 * **`fetch` ではなく `node:http` で話す。** テストからの `fetch` は宛先を問わず番人が止める
 * （`tests/network-guard.ts`。ローカルへ話すなら子プロセスか `node:http`、と同ファイルが書く）。
 * 宛先は `127.0.0.1` に固定する——プロキシの設定を読まないので、外へ回ることもない。
 */
export function requestJson(
  port: number,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        method,
        path,
        headers: payload === undefined ? {} : { "content-type": "application/json" },
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.once("error", reject);
    req.end(payload);
  });
}
