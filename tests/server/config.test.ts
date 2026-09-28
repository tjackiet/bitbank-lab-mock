import { describe, expect, it } from "vitest";
import {
  fillMode,
  isControlEnabled,
  listenHost,
  streamAssetKeys,
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
});
