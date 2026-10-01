import { describe, expect, it } from "vitest";
import {
  apiCredentials,
  apiCredentialsConflict,
  clockMode,
  fillMode,
  isControlEnabled,
  listenHost,
  streamAssetKeys,
  virtualClockConflicts,
} from "../../src/server/config.ts";

describe("server config", () => {
  it("enables control only when BITBANK_MOCK_CONTROL=1", () => {
    expect(isControlEnabled({})).toBe(false);
    expect(isControlEnabled({ BITBANK_MOCK_CONTROL: "1" })).toBe(true);
    expect(isControlEnabled({ BITBANK_MOCK_CONTROL: "true" })).toBe(false);
  });

  it("defaults fillMode to manual when control is on", () => {
    expect(fillMode({})).toBe("market");
    expect(fillMode({ BITBANK_MOCK_CONTROL: "1" })).toBe("manual");
    expect(fillMode({ BITBANK_MOCK_CONTROL: "1", BITBANK_MOCK_FILL_MODE: "market" })).toBe(
      "market",
    );
    expect(fillMode({ BITBANK_MOCK_FILL_MODE: "manual" })).toBe("manual");
  });

  it("binds loopback when control is on unless host is set", () => {
    expect(listenHost({})).toBe("0.0.0.0");
    expect(listenHost({ BITBANK_MOCK_CONTROL: "1" })).toBe("127.0.0.1");
    expect(listenHost({ BITBANK_MOCK_CONTROL: "1", BITBANK_MOCK_HOST: "0.0.0.0" })).toBe("0.0.0.0");
  });

  it("asset_update のキーは既定 camel で、snake のときだけ snake", () => {
    expect(streamAssetKeys({})).toBe("camel");
    expect(streamAssetKeys({ BITBANK_MOCK_STREAM_ASSET_KEYS: "snake" })).toBe("snake");
    expect(streamAssetKeys({ BITBANK_MOCK_STREAM_ASSET_KEYS: "camel" })).toBe("camel");
    // 空文字と未知の値は既定に落とす（他の env と同じ規則）。
    expect(streamAssetKeys({ BITBANK_MOCK_STREAM_ASSET_KEYS: "" })).toBe("camel");
    expect(streamAssetKeys({ BITBANK_MOCK_STREAM_ASSET_KEYS: "SNAKE" })).toBe("camel");
  });

  it("時計は既定 real で、virtual のときだけ virtual", () => {
    expect(clockMode({})).toBe("real");
    expect(clockMode({ BITBANK_MOCK_CLOCK: "virtual" })).toBe("virtual");
    expect(clockMode({ BITBANK_MOCK_CLOCK: "real" })).toBe("real");
    // 空文字と未知の値は既定に落とす（他の env と同じ規則）。
    expect(clockMode({ BITBANK_MOCK_CLOCK: "" })).toBe("real");
    expect(clockMode({ BITBANK_MOCK_CLOCK: "VIRTUAL" })).toBe("real");
  });

  /**
   * 仮想時計は control 有効かつ manual のときだけ使える（`docs/plan-lab-mock.md` 17.2 の決定 24）。
   * 理由は 2 つあり、**同時に当たれば両方を返す**——control 無効の既定は market なので、
   * control を有効にし忘れただけでも 2 つ出る。
   */
  it("仮想時計と矛盾する設定を理由ごとに返す", () => {
    const virtual = { BITBANK_MOCK_CLOCK: "virtual" };
    const control = "BITBANK_MOCK_CONTROL が 1 ではない";
    const market = "約定のさせ方が market";

    expect(virtualClockConflicts({ ...virtual, BITBANK_MOCK_CONTROL: "1" })).toEqual([]);
    expect(
      virtualClockConflicts({
        ...virtual,
        BITBANK_MOCK_CONTROL: "1",
        BITBANK_MOCK_FILL_MODE: "manual",
      }),
    ).toEqual([]);

    const noControl = virtualClockConflicts(virtual);
    expect(noControl).toHaveLength(2);
    expect(noControl[0]).toContain(control);
    expect(noControl[1]).toContain(market);

    const explicitMarket = virtualClockConflicts({
      ...virtual,
      BITBANK_MOCK_CONTROL: "1",
      BITBANK_MOCK_FILL_MODE: "market",
    });
    expect(explicitMarket).toHaveLength(1);
    expect(explicitMarket[0]).toContain(market);

    const noControlManual = virtualClockConflicts({ ...virtual, BITBANK_MOCK_FILL_MODE: "manual" });
    expect(noControlManual).toHaveLength(1);
    expect(noControlManual[0]).toContain(control);

    // 仮想時計を指定していなければ、組み合わせは見ない（既定の挙動を変えない）。
    expect(virtualClockConflicts({})).toEqual([]);
    expect(virtualClockConflicts({ BITBANK_MOCK_FILL_MODE: "market" })).toEqual([]);
    expect(virtualClockConflicts({ BITBANK_MOCK_CLOCK: "VIRTUAL" })).toEqual([]);
  });

  /**
   * 認証のキーとシークレット（`docs/plan-lab-mock.md` 19.2 の決定 37）。両方そろったときだけ検証し、
   * どちらも無ければ検証しない（既定）。片方だけなら起動を断る理由を返す。空文字は未設定。
   */
  it("認証のキーとシークレットは両方そろったときだけ返す", () => {
    const both = { BITBANK_MOCK_API_KEY: "k", BITBANK_MOCK_API_SECRET: "s" };
    expect(apiCredentials(both)).toEqual({ key: "k", secret: "s" });
    expect(apiCredentials({})).toBeNull();
    expect(apiCredentials({ BITBANK_MOCK_API_KEY: "k" })).toBeNull();
    expect(apiCredentials({ ...both, BITBANK_MOCK_API_SECRET: "" })).toBeNull();
  });

  it("キーとシークレットの片方だけなら、起動を断る理由を返す", () => {
    expect(apiCredentialsConflict({})).toBeNull();
    expect(
      apiCredentialsConflict({ BITBANK_MOCK_API_KEY: "", BITBANK_MOCK_API_SECRET: "" }),
    ).toBeNull();
    expect(
      apiCredentialsConflict({ BITBANK_MOCK_API_KEY: "k", BITBANK_MOCK_API_SECRET: "s" }),
    ).toBeNull();
    expect(apiCredentialsConflict({ BITBANK_MOCK_API_KEY: "k" })).toContain(
      "BITBANK_MOCK_API_KEY だけ",
    );
    expect(
      apiCredentialsConflict({ BITBANK_MOCK_API_KEY: "", BITBANK_MOCK_API_SECRET: "s" }),
    ).toContain("BITBANK_MOCK_API_SECRET だけ");
  });
});
