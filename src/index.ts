import { defaultStatePath, sweepOrphanTempFiles } from "./engine/persist.ts";
import { PRIVATE_STREAM_PATH } from "./routes/private-stream.ts";
import {
  clockMode,
  fillMode,
  isControlEnabled,
  listenHost,
  persistFailureMode,
  virtualClockConflicts,
} from "./server/config.ts";
import { buildServer } from "./server/http.ts";
import { acquireStateLock, StateLockedError } from "./store/lock.ts";
import { loadOrInitDefault } from "./store/session.ts";

const DEFAULT_PORT = 14000;
const DEFAULT_INITIAL_JPY = 1_000_000;

function parsePort(argv: string[]): number {
  const isValidPort = (n: number): boolean => Number.isInteger(n) && n >= 1 && n <= 65535;
  const i = argv.indexOf("--port");
  if (i >= 0 && argv[i + 1]) {
    const n = Number(argv[i + 1]);
    if (isValidPort(n)) return n;
  }
  if (process.env.BITBANK_MOCK_PORT) {
    const n = Number(process.env.BITBANK_MOCK_PORT);
    if (isValidPort(n)) return n;
  }
  return DEFAULT_PORT;
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? "serve";
  if (cmd !== "serve") {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
  const port = parsePort(argv);
  const control = isControlEnabled();
  const mode = fillMode();
  const clock = clockMode();
  const persistMode = persistFailureMode();
  const host = listenHost();

  // 仮想時計と矛盾する設定なら、状態ファイルに触れる前に断る（`docs/plan-lab-mock.md` 17.2 の
  // 決定 24）。warn で済ませて実時刻へ落とすと、時計を進めたつもりの実験が黙って実時刻で走る。
  const conflicts = virtualClockConflicts();
  if (conflicts.length > 0) {
    console.error(
      "BITBANK_MOCK_CLOCK=virtual は BITBANK_MOCK_CONTROL=1 かつ manual モードのときだけ使えます: " +
        conflicts.join(" / "),
    );
    process.exit(1);
  }

  // 状態ファイルを読む前に排他を取る。取れなければ起動しない。
  // 2 プロセスが同じ状態ファイルを使うと、両方が成功を返しながら片方の注文が丸ごと消える。
  const statePath = defaultStatePath("default");
  const lock = await acquireStateLock(statePath);

  // 排他を取ったあとで掃除する。ロックが無いと、他プロセスが書いている最中の
  // 一時ファイルを消しかねない（計画 10.3 が PR 5 を PR 4 の後に置いた理由）。
  const swept = await sweepOrphanTempFiles(statePath, {
    logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
  });
  if (swept > 0) console.log(`孤児の一時ファイルを ${swept} 件片付けました`);

  // ロックと同じ statePath を渡す。導出を 2 か所に持つと、片方だけ変わったときに
  // 「ロックしたファイルとは別のファイルを読む」形になる。
  const store = await loadOrInitDefault(DEFAULT_INITIAL_JPY, {
    path: statePath,
    logger: { warn: (m) => console.warn(m), info: (m) => console.log(m) },
    fillMode: mode,
    clockMode: clock,
  });
  const fastify = await buildServer({
    store,
    logger: true,
    controlEnabled: control,
    controlToken: process.env.BITBANK_MOCK_CONTROL_TOKEN,
  });

  // 落とすときにロックを置いていかない。SIGKILL で残った分は次の起動が stale として奪う。
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`${signal} を受け取ったので停止します`);
    // 停止の経路から例外を出さない。ハンドラは `void shutdown(signal)` で呼ぶので、
    // ここで投げると unhandled rejection になり、**`process.exit()` に到達しないまま**
    // ランタイム任せで落ちる（スタックトレース付きの終了コード 1 になることを実測した）。
    let exitCode = 0;
    try {
      await fastify.close();
    } catch (e) {
      exitCode = 1;
      console.error(`サーバを停止できませんでした: ${e}`);
    } finally {
      // 解放の失敗で停止を止めない。残ったロックは次の起動が stale として奪う。
      await lock
        .release()
        .catch((e: unknown) => console.warn(`ロックを解放できませんでした: ${e}`));
      process.exit(exitCode);
    }
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown(signal);
    });
  }

  try {
    await fastify.listen({ port, host });
  } catch (e) {
    // 解放に失敗しても、投げ直すのは listen の失敗のほう。原因を後片付けで隠さない。
    await lock
      .release()
      .catch((re: unknown) => console.warn(`ロックを解放できませんでした: ${re}`));
    throw e;
  }
  // persistFailure は既定が degrade（v0.1.0 からの変更）なので、起動時に見えるようにしておく。
  console.log(
    `bitbank-lab-mock listening on http://${host}:${port} fillMode=${mode} ` +
      `persistFailure=${persistMode}${control ? " control=on" : ""}` +
      `${clock === "virtual" ? " clock=virtual" : ""}`,
  );
  // private stream は PubNub ではなく素の WebSocket なので、接続先を起動時に見せておく。
  console.log(`private stream: ws://${host}:${port}${PRIVATE_STREAM_PATH}`);
}

main().catch((e) => {
  // 排他で弾かれたときは、スタックではなく何をすればよいかだけを出す。
  if (e instanceof StateLockedError) console.error(e.message);
  else console.error(e);
  process.exit(1);
});
