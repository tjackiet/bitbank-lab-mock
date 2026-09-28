import type { Logger } from "../engine/types.ts";
import { noopLogger } from "../engine/types.ts";
import type { AssetKeyStyle } from "../routes/format.ts";
import type { SessionStore, StateChange } from "../store/session.ts";
import { type PrivateStreamMessage, stateChangeMessages } from "./events.ts";

/**
 * 作ったメッセージを送る前に通す関数。**Plan A では恒等写像（`passThrough`）**で、
 * 1 回の状態の差し替えで作った列をそのまま返す。
 *
 * 置いてあるのは障害注入の差し込み口としてである（`docs/plan-lab-mock.md` 3.4）。
 * 公式は private stream の順序も重複の無さも保証していないので、利用側はそれに耐える必要が
 * ある。重複・順序入替・欠落を起こす関数をここへ渡せば、状態とイベントを作る側
 * （`src/stream/events.ts`）に手を入れずに再現できる。
 *
 * 呼ばれるのは購読者が 1 人以上いるときだけで、1 回の差し替えにつき 1 回。
 */
export type DeliveryPolicy = (messages: PrivateStreamMessage[]) => PrivateStreamMessage[];

/** 既定の配信方針。何も足さず、何も落とさず、並べ替えない。 */
export const passThrough: DeliveryPolicy = (messages) => messages;

/**
 * 購読者 1 人ぶんの口。WebSocket そのものではなく、送ると閉じるの 2 つだけを見せる
 * （ハブを WebSocket の実装から切り離してテストできるようにするため）。
 */
export interface StreamClient {
  send(text: string): void;
  close(code: number, reason: string): void;
}

/**
 * 状態を初期化したときに接続を閉じるコード。**1012（Service Restart）**を使う。
 *
 * reset の後は注文 id が 1 から配り直されるので、接続を保ったまま差分を送り続けると、利用側の
 * 手元では「前の注文 1」と「新しい注文 1」が同じ注文に見える。公式の例のコード
 * （`private-stream.md:661-683`）のように「状態が進んだときだけ上書きする」写し方をしていると、
 * 前の注文 1 が `FULLY_FILLED` なら新しい注文 1 の更新は**すべて捨てられる**。
 * 接続を切れば、利用側は公式の再接続の手順（`private-stream.md:505-512`）に入り、REST で
 * 取り直すきっかけを得る（`docs/fidelity.md` の「private stream と状態の初期化」）。
 */
export const RESET_CLOSE_CODE = 1012;
export const RESET_CLOSE_REASON = "state reset by /_control/reset";

export type PrivateStreamHubOptions = {
  assetKeys: AssetKeyStyle;
  deliveryPolicy?: DeliveryPolicy;
  logger?: Logger;
};

/**
 * private stream の配信元。`SessionStore` の状態の差し替えを購読し、差からメッセージを作って
 * 接続中の全員へ送る。
 *
 * **送るのはメモリへ反映した直後**で、書き出しの成否も HTTP 応答も待たない
 * （`docs/plan-lab-mock.md` 16 節の決定 14）。そのため、発注の応答より先に `spot_order_new` が
 * 届くことがあり、書き出しに失敗して `70001` を返した要求のイベントも流れる。
 *
 * 購読者がいないときは何も作らない（stream を使わない利用者に整形の費用を払わせない）。
 * 購読者の単位は口座全体で、チャンネルやトークンで分けない（このモックの口座は 1 つ）。
 */
export class PrivateStreamHub {
  private readonly clients = new Set<StreamClient>();
  private readonly assetKeys: AssetKeyStyle;
  private readonly deliveryPolicy: DeliveryPolicy;
  private readonly logger: Logger;
  private unsubscribe: (() => void) | null = null;

  constructor(
    private readonly store: SessionStore,
    opts: PrivateStreamHubOptions,
  ) {
    this.assetKeys = opts.assetKeys;
    this.deliveryPolicy = opts.deliveryPolicy ?? passThrough;
    this.logger = opts.logger ?? noopLogger;
  }

  /** store の購読を始める。2 回呼んでも購読は 1 本。 */
  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.store.onStateChange((change) => this.onStateChange(change));
  }

  /** store の購読をやめる。接続は閉じない（閉じるのは WebSocket サーバの側の役目）。 */
  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
  }

  /** 購読者を足す。戻り値の関数を呼ぶと外れる（接続が閉じたときに呼ぶ）。 */
  addClient(client: StreamClient): () => void {
    this.clients.add(client);
    return () => {
      this.clients.delete(client);
    };
  }

  /** 接続中の購読者の数。 */
  clientCount(): number {
    return this.clients.size;
  }

  /**
   * store の差し替え 1 回を受け取る。reset なら全員を閉じ、それ以外は差からメッセージを作って
   * 配信方針を通してから送る。
   */
  private onStateChange(change: StateChange): void {
    if (this.clients.size === 0) return;
    if (change.kind === "reset") {
      this.closeAll(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
      return;
    }
    const messages = this.deliveryPolicy(
      stateChangeMessages(change.prev, change.next, {
        feeRate: this.store.feeRate,
        assetKeys: this.assetKeys,
      }),
    );
    // 外側をメッセージ、内側を購読者にする。どの購読者にも同じ順で届き、JSON 化は 1 通 1 回で済む。
    for (const m of messages) {
      const text = JSON.stringify(m);
      for (const client of [...this.clients]) this.sendTo(client, text);
    }
  }

  /**
   * 1 人へ送る。**送れなかった購読者は外して閉じる**——残すと以後のメッセージが黙って
   * 抜け続けるので、切って再接続させたほうが利用側は気づける。例外は外へ出さない
   * （出すと状態の差し替えの通知元である `SessionStore.setState()` まで戻る）。
   */
  private sendTo(client: StreamClient, text: string): void {
    try {
      client.send(text);
    } catch (e) {
      this.clients.delete(client);
      try {
        client.close(1011, "send failed");
      } catch {
        // 既に壊れている接続。外したので、以後は送らない。
      }
      try {
        const message = e instanceof Error ? e.message : String(e);
        this.logger.warn(`private stream: send failed, closing: ${JSON.stringify(message)}`);
      } catch {
        // ログに出せなくても、残りの購読者への配信は続ける。
      }
    }
  }

  /** 全員を閉じて外す（reset のとき）。閉じ損ねても外すので、以後は送らない。 */
  private closeAll(code: number, reason: string): void {
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) {
      try {
        client.close(code, reason);
      } catch {
        // 閉じ損ねても外してあるので、以後は送らない。
      }
    }
  }
}
