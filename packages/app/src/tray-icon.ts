/** The bean's orange (the app icon's body), readable on light and dark Windows taskbars alike. */
export const TRAY_TINT = [232, 120, 60] as const;

/** The tray asset is a macOS template image (black + alpha) that only macOS recolors for the menu bar;
 * elsewhere a black bean vanishes on a dark taskbar. Paints every pixel of a premultiplied BGRA bitmap
 * (`nativeImage.toBitmap()`'s format) in `rgb`, keeping its alpha. */
export function tintBitmap(bitmap: Buffer, [r, g, b]: readonly [number, number, number]): Buffer {
  const out = Buffer.from(bitmap);
  for (let i = 0; i + 3 < out.length; i += 4) {
    const a = out[i + 3]! / 255;
    out[i] = Math.round(b * a);
    out[i + 1] = Math.round(g * a);
    out[i + 2] = Math.round(r * a);
  }
  return out;
}
