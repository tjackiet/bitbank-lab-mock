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
 * 呼ばれるのは購読者が 1 人以上いるか保留中のときだけで、1 回の差し替えにつき 1 回。保留中は
 * この関数を通した後の列を溜める（`PrivateStreamHub.hold()`）。
 *
 * **1 回の差し替えの中しか見ない**ので、変化をまたいだ入れ替え（全量約定の後に、その前の
 * 部分約定の通知を届ける）はこの形では作れない。それは保留・再送が受け持つ。
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

/**
 * `/_control/stream/disconnect` で接続を閉じるコード。**1001（Going Away）**を使う
 * （`docs/plan-lab-mock.md` 18.2 の決定 35）。
 *
 * 公式の配信は PubNub で、close code は利用側の本番の経路に現れない。効くのはモック向けの
 * 接続層だけなので、本物らしさより他の切れ方と区別できることを優先した——`1009`（大きすぎる
 * フレーム）・`1011`（送れなかった。`sendTo()`）・`1012`（reset。手元の注文の対応表を捨てる
 * 合図）のどれとも重ならない。状態は残すので、利用側は対応表を捨てずに REST で照合すればよい。
 */
export const DISCONNECT_CLOSE_CODE = 1001;
export const DISCONNECT_CLOSE_REASON = "disconnected by /_control/stream/disconnect";

/**
 * 保留中に溜めるメッセージの通数の上限（既定）。
 *
 * 上限に達すると、以後の変化は溜めずに「溢れた」印と落とした通数だけを残し、release を断る
 * （`docs/fidelity.md` の「private stream の保留・再送」節）。状態を変える要求そのものは
 * 断らないので、保留を解き忘れたまま互換ルートを叩き続けてもメモリはこの上限で止まる。
 *
 * 1 万にしたのは、手で組む入れ替えのシナリオ（多くて数十通）に十分な余白を残しつつ、
 * 利用側のエージェントを保留したまま走らせる実験（1 発注で 2〜4 通。上限に当たるまで
 * 数千発注）でも収まるようにするため。1 通は数百バイトなので、溜めきっても数 MB で済む。
 */
export const DEFAULT_HOLD_LIMIT = 10_000;

export type PrivateStreamHubOptions = {
  assetKeys: AssetKeyStyle;
  deliveryPolicy?: DeliveryPolicy;
  logger?: Logger;
  /** 保留中に溜める通数の上限。省略時は `DEFAULT_HOLD_LIMIT`。正の整数に限る。 */
  holdLimit?: number;
};

/** 保留の状況。`POST /_control/stream/hold` と `GET /_control/stream/held` が返す。 */
export type HoldStatus = {
  holding: boolean;
  /** 溜めている通数。 */
  held: number;
  limit: number;
  /** 上限に達して、溜められなかった変化があったか。立ったら reset まで下りない。 */
  overflowed: boolean;
  /** 溢れた後に溜めずに落とした通数。 */
  dropped: number;
};

/**
 * 溜めたメッセージ 1 通。`seq` は保留を始めてから溜めた順に 1 から振る番号で、release の
 * `order` はこれで指す。`frame` は WebSocket の 1 フレームにそのまま載る JSON。
 */
export type HeldMessage = { seq: number; frame: PrivateStreamMessage };

/** release で送ったもの。 */
export type ReleaseSummary = {
  /** 送った通数（重複して指定した分も数える）。購読者 1 人あたりの数。 */
  sent: number;
  /** 指定しなかった（＝欠落させた）番号。溜めた順。 */
  omitted: number[];
  /** 送った時点で接続していた購読者の数。0 になるのは送った通数も 0 のときだけ。 */
  clients: number;
};

/**
 * release を断る理由。
 *
 * - `NOT_HOLDING`: 保留していない
 * - `OVERFLOWED`: 上限に達して落とした変化がある。送ると欠落が利用者の指定ではなく
 *   モックの都合で起きるので、送らない。抜け出すのは reset
 * - `INVALID_ORDER`: `order` が溜めた番号の範囲外・整数でない・上限より長い
 * - `NO_CLIENTS`: 送るものが 1 通以上あるのに購読者が 0 人。送っても誰にも届かずに消えるので、
 *   送らない（溢れと同じく、溜めたものを黙って消さない）。捨てたいときは空の `order` で release する
 */
export type ReleaseError = "NOT_HOLDING" | "OVERFLOWED" | "INVALID_ORDER" | "NO_CLIENTS";

export type ReleaseResult =
  | { success: true; data: ReleaseSummary }
  | { success: false; error: ReleaseError };

/** 保留中の中身。`PaperState` には入れず、永続化もしない（配信の層の話なので）。 */
type HoldBuffer = {
  frames: PrivateStreamMessage[];
  overflowed: boolean;
  dropped: number;
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
 * **ただし保留中は購読者が 0 人でも作って溜める**——利用側が止まっている間に起きた変化を、
 * 繋ぎ直した後に release で届けられるようにするため。
 * 購読者の単位は口座全体で、チャンネルやトークンで分けない（このモックの口座は 1 つ）。
 *
 * **保留・再送（`hold()` / `heldMessages()` / `release()`）** は、公式が保証しない順序の
 * 入れ替わり・重複・欠落を `/_control/` から起こすための口である。hold の後に作った
 * メッセージは送らずに溜め、release で**どれを・どの順で・何回**送るかを番号の並びで
 * 指定する。モック自身は入れ替えない（`docs/fidelity.md` の「private stream の順序」）。
 *
 * **切断（`disconnectAll()` / `refuse()` / `accept()`）** は、状態を残したまま stream を
 * 切るための口である（`docs/fidelity.md` の「private stream の切断」）。reset と違って状態にも
 * 保留にも触れない。受け付けるかどうかはここに持つが、断るのは WebSocket の upgrade の前の
 * HTTP の層（`src/routes/private-stream.ts`）で、hub は `addClient()` で断らない。
 */
export class PrivateStreamHub {
  private readonly clients = new Set<StreamClient>();
  private readonly assetKeys: AssetKeyStyle;
  private readonly deliveryPolicy: DeliveryPolicy;
  private readonly logger: Logger;
  private unsubscribe: (() => void) | null = null;
  /** 保留中の中身。`null` なら保留していない（通常の配信）。 */
  private buffer: HoldBuffer | null = null;
  /** 新しい接続を受け付けるか。`refuse()` で下ろし、`accept()` と reset で戻す。 */
  private accepting = true;
  /** 保留中に溜める通数の上限。 */
  readonly holdLimit: number;

  constructor(
    private readonly store: SessionStore,
    opts: PrivateStreamHubOptions,
  ) {
    this.assetKeys = opts.assetKeys;
    this.deliveryPolicy = opts.deliveryPolicy ?? passThrough;
    this.logger = opts.logger ?? noopLogger;
    const limit = opts.holdLimit ?? DEFAULT_HOLD_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new RangeError(`holdLimit must be a positive integer: ${JSON.stringify(limit)}`);
    }
    this.holdLimit = limit;
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
   * 接続中の全員を `DISCONNECT_CLOSE_CODE`（1001）で閉じて外し、閉じた数を返す。0 人でも投げない。
   *
   * **状態・保留・溜めたもの・受け付けるかどうかには触れない**（reset との違い）。切っている間の
   * 変化は、保留していなければ誰にも届かない（購読者が 0 人の間はメッセージを作らない）。
   * 後から届けたいなら、切る前に `hold()` して、繋ぎ直してから `release()` する。
   * 切ったまま繋がらない状態を保ちたいなら、**先に `refuse()` する**（後だと、その間に繋ぎ直され得る）。
   */
  disconnectAll(): number {
    return this.closeAll(DISCONNECT_CLOSE_CODE, DISCONNECT_CLOSE_REASON);
  }

  /** 新しい接続を受け付けない状態にする。既にそうなら何もしない。今の接続は閉じない。 */
  refuse(): void {
    this.accepting = false;
  }

  /** 新しい接続を受け付ける状態に戻す。既にそうなら何もしない。 */
  accept(): void {
    this.accepting = true;
  }

  /** 新しい接続を受け付けるか。既定と reset の後は `true`。 */
  isAccepting(): boolean {
    return this.accepting;
  }

  /**
   * 保留を始める。以後の変化のメッセージは送らずに溜める。**既に保留中なら何もしない**
   * （溜めたものは捨てない。番号も振り直さない）ので、戻り値の `held` で溜まっている数を
   * 確かめられる。
   */
  hold(): HoldStatus {
    if (this.buffer === null) this.buffer = { frames: [], overflowed: false, dropped: 0 };
    return this.holdStatus();
  }

  /** 保留の状況。保留していなければ `holding: false` で数はすべて 0。 */
  holdStatus(): HoldStatus {
    const b = this.buffer;
    return {
      holding: b !== null,
      held: b?.frames.length ?? 0,
      limit: this.holdLimit,
      overflowed: b?.overflowed ?? false,
      dropped: b?.dropped ?? 0,
    };
  }

  /** 溜めたメッセージを、溜めた順に番号（1 から）を付けて返す。保留していなければ空。 */
  heldMessages(): HeldMessage[] {
    return (this.buffer?.frames ?? []).map((frame, i) => ({ seq: i + 1, frame }));
  }

  /**
   * 溜めたものを `order` の番号の順に、**その時点で接続している全員へ**送り、保留を解いて
   * 通常の配信に戻す。同じ番号を 2 度書けば重複、書かなかった番号は欠落になる。`order` を
   * 省略したら溜めた順にすべて送る。
   *
   * 送る相手は release の時点の購読者で、**保留の後に繋いだ接続にも、繋ぐ前の変化が届く**
   * （「接続した後の変化だけが届く」の例外。`docs/fidelity.md` の「private stream の保留・再送」）。
   * **送るものが 1 通以上あるのに購読者が 0 人なら断る**——利用側が繋ぎ直す前に release すると、
   * 溜めたものが誰にも届かずに消えるため。空の `order`（送るものが 0 通）は購読者がいなくても通るので、
   * 溜めたものを捨てたいときはそれで保留を解く。
   *
   * 断ったとき（`success: false`）は保留も溜めたものもそのまま残す。
   */
  release(order?: readonly number[]): ReleaseResult {
    const buffer = this.buffer;
    if (buffer === null) return { success: false, error: "NOT_HOLDING" };
    if (buffer.overflowed) return { success: false, error: "OVERFLOWED" };
    const count = buffer.frames.length;
    const seqs = order ?? buffer.frames.map((_, i) => i + 1);
    // 送る通数の上限は溜める上限と同じ。重複の指定で際限なく送らせないため。
    if (seqs.length > this.holdLimit) return { success: false, error: "INVALID_ORDER" };
    const frames: PrivateStreamMessage[] = [];
    for (const seq of seqs) {
      const frame = Number.isInteger(seq) ? buffer.frames[seq - 1] : undefined;
      if (frame === undefined) return { success: false, error: "INVALID_ORDER" };
      frames.push(frame);
    }
    if (frames.length > 0 && this.clients.size === 0) {
      return { success: false, error: "NO_CLIENTS" };
    }
    // 送る前に保留を解く。送信は同期で store に触れないので、送っている途中に溜まるものは無い。
    this.buffer = null;
    const clients = this.clients.size;
    this.broadcast(frames);
    const listed = new Set(seqs);
    const omitted: number[] = [];
    for (let seq = 1; seq <= count; seq++) if (!listed.has(seq)) omitted.push(seq);
    return { success: true, data: { sent: frames.length, omitted, clients } };
  }

  /**
   * store の差し替え 1 回を受け取る。reset なら溜めたものを捨てて保留を解き、受け付ける状態に
   * 戻して全員を閉じる。それ以外は差からメッセージを作って配信方針を通し、保留中なら溜め、
   * そうでなければ送る。
   */
  private onStateChange(change: StateChange): void {
    if (change.kind === "reset") {
      // reset の前の注文のメッセージを、id を 1 から配り直した後に届けない（接続を閉じる
      // 理由と同じ）。保留も解き、受け付ける状態にも戻すので、前の実験で解き忘れていても
      // シナリオの冒頭の reset で戻る（`docs/plan-lab-mock.md` 17.2 の決定 21 と 18.2 の決定 35）。
      this.buffer = null;
      this.accepting = true;
      this.closeAll(RESET_CLOSE_CODE, RESET_CLOSE_REASON);
      return;
    }
    if (this.clients.size === 0 && this.buffer === null) return;
    const messages = this.deliveryPolicy(
      stateChangeMessages(change.prev, change.next, {
        feeRate: this.store.feeRate,
        assetKeys: this.assetKeys,
      }),
    );
    if (this.buffer !== null) {
      this.stash(this.buffer, messages);
      return;
    }
    this.broadcast(messages);
  }

  /**
   * 1 回の変化のメッセージを溜める。**入りきらなければその変化は丸ごと溜めず**、そこから先の
   * 変化もすべて落として数える——途中の変化だけが抜けた列を溜めると、release で届く欠落が
   * 利用者の指定によるものかモックの都合によるものか区別できなくなるため。溢れたら release は
   * 断られる（`release()`）。時計だけの変化のようにメッセージを作らない変化は数えない。
   */
  private stash(buffer: HoldBuffer, messages: PrivateStreamMessage[]): void {
    if (messages.length === 0) return;
    if (!buffer.overflowed && buffer.frames.length + messages.length <= this.holdLimit) {
      buffer.frames.push(...messages);
      return;
    }
    if (!buffer.overflowed) {
      buffer.overflowed = true;
      try {
        this.logger.warn(
          `private stream: hold buffer is full (limit ${this.holdLimit}); ` +
            "later messages are dropped and release is refused until POST /_control/reset",
        );
      } catch {
        // ログに出せなくても、印と落とした数は held に残る。
      }
    }
    buffer.dropped += messages.length;
  }

  /**
   * 接続中の全員へ送る。外側をメッセージ、内側を購読者にする（どの購読者にも同じ順で届き、
   * JSON 化は 1 通 1 回で済む）。
   */
  private broadcast(messages: readonly PrivateStreamMessage[]): void {
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

  /**
   * 全員を閉じて外し、外した数を返す（reset と `disconnectAll()`）。閉じ損ねても外すので、
   * 以後は送らない。数には閉じ損ねた購読者も入る。
   */
  private closeAll(code: number, reason: string): number {
    const clients = [...this.clients];
    this.clients.clear();
    for (const client of clients) {
      try {
        client.close(code, reason);
      } catch {
        // 閉じ損ねても外してあるので、以後は送らない。
      }
    }
    return clients.length;
  }
}
