import { describe, expect, it } from "vitest";
import { tintBitmap } from "../src/tray-icon.js";

describe("tintBitmap (#813)", () => {
  it("paints premultiplied BGRA pixels in the tint, keeping alpha", () => {
    const px = Buffer.from([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]);
    expect([...tintBitmap(px, [200, 100, 50])]).toEqual([50, 100, 200, 255, 0, 0, 0, 0, 25, 50, 100, 128]);
    expect([...px]).toEqual([0, 0, 0, 255, 0, 0, 0, 0, 0, 0, 0, 128]); // input untouched
  });
});
