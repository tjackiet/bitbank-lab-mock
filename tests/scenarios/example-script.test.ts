import { type ChildProcess, spawn } from "node:child_process";
import { statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { freePort, spawnServer, waitForExit, waitUntilListening } from "../server-process.ts";

/**
 * `examples/scenario-plan-a.sh` を実際に流す。
 *
 * このスクリプトは README（「[試す](../../README.md)」の手順）と
 * `docs/plan-a-readiness.md` が**最初に流してほしい**と書いているデモで、`set -euo pipefail` と
 * `require_status()` などで自分の期待も検査している。後半は private stream の切断の口
 * （refuse → disconnect → accept）を curl だけで通す。それでも**誰も走らせていなかった**ので、
 * 応答の形が変わっても、経路の名前が変わっても、気付くのはこれを手で流した人だけだった。
 * 検査を持っているスクリプトを走らせないのは、検査を書いていないのと同じである。
 *
 * ここが見るのは**スクリプト自身**で、同じ流れの結合テスト（`tests/scenarios/plan-a.test.ts`）
 * とは別物である。あちらは `inject()` で組み上げたサーバを叩くので、実際に listen した口、
 * curl から見た応答、`BITBANK_MOCK_CONTROL=1` のときに fillMode が manual になる既定の配線を
 * 通らない。ここはそれらを全部通る。
 *
 * CI を足すのではなくテストにしてあるのは、`npm test` で手元でも走るようにするためと、
 * 落ちた回でもサーバを確実に片付けるため（`afterEach`）。
 */

const SCRIPT = "examples/scenario-plan-a.sh";

/** スクリプトを流して、終了コードと出力を返す。 */
function runScript(env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [SCRIPT], {
      env: { ...process.env, ...env },
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
    // `exit` ではなく `close` を待つ。`exit` の時点では出力が残っていることがある。
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// Windows では前提が 2 つ崩れる（`bash` が居ることと、実行ビットが git から復元されること）。
// CI は ubuntu で、ここが守るのは POSIX の実行手順なので、そちらでだけ走らせる。
describe.skipIf(process.platform === "win32")("examples/scenario-plan-a.sh", () => {
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

  it("実行できる形で置かれている", () => {
    // README は `./examples/scenario-plan-a.sh` と書いている。実行ビットが落ちると
    // その手順だけが黙って壊れる（`bash <file>` で流す下のテストは気付かない）。
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("起動したサーバに対して通り、最後まで到達する", async () => {
    dir = await mkdtemp(join(tmpdir(), "bitbank-mock-example-"));
    const port = await freePort();

    child = spawnServer({
      // 開発者の本物の状態ファイルに触らない。
      BITBANK_MOCK_STATE_PATH: join(dir, "state.json"),
      BITBANK_MOCK_PORT: String(port),
      BITBANK_MOCK_CONTROL: "1",
      // スクリプトは fillMode が manual であることに乗っている（`/_control/` の fill より
      // 先に市場足で約定すると 409 になる）。**`manual` を明示しない**のは、
      // 「control を有効にすると manual になる」という既定の配線もここで通したいため。
      // 開発者の環境に `market` が輸出されていても揺れないよう、継いだ値だけ落とす
      // （`undefined` を渡すと Node は envp から外す。実測で確認した）。
      BITBANK_MOCK_FILL_MODE: undefined,
    });
    await waitUntilListening(child);

    const r = await runScript({
      BITBANK_MOCK_URL: `http://127.0.0.1:${port}`,
      // プロキシ越しの環境で 127.0.0.1 が外へ回らないようにする。
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    });

    expect(
      r.code,
      `スクリプトが失敗した\n--- stdout ---\n${r.stdout}\n--- stderr ---\n${r.stderr}`,
    ).toBe(0);

    // 終了コードだけだと、途中で何も出さずに抜けた場合と区別できない。
    // スクリプトが刻む残高の三段が全部出ていることを見る。
    expect(r.stdout).toContain("発注前の jpy");
    expect(r.stdout).toContain("発注後の jpy");
    expect(r.stdout).toContain("約定後の jpy");
    // 後半の private stream の切断も、refuse の 503 から accept の後の 426 まで通っている。
    expect(r.stdout).toContain('{"error":"STREAM_REFUSED"}（HTTP 503）');
    expect(r.stdout).toContain("切断中の照合");
    expect(r.stdout).toContain('{"error":"UPGRADE_REQUIRED"}（HTTP 426）');
  }, 40_000);
});
