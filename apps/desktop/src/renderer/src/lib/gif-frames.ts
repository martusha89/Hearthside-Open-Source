import { decompressFrames, parseGIF } from "gifuct-js";

/**
 * Hearthside: a GIF as one picture an agent can look at. Up to nine frames from
 * across the animation, in order, numbered with their time, in a grid (a "contact sheet"),
 * so the agent sees the motion rather than only the GIF's title.
 */

export const GIF_FRAMES_NAME = "GIF frames, in order, with times.jpg";

export async function gifContactSheet(bytes: ArrayBuffer, count = 9): Promise<string> {
  const gif = parseGIF(bytes);
  const frames = decompressFrames(gif, true);
  if (frames.length === 0) throw new Error("That GIF has no frames.");
  const width = gif.lsd.width || frames[0]!.dims.width;
  const height = gif.lsd.height || frames[0]!.dims.height;

  // Play the GIF onto a canvas frame by frame, grabbing evenly spaced frames.
  const picks = new Set(Array.from({ length: Math.min(count, frames.length) }, (_, index) => Math.round((index * (frames.length - 1)) / Math.max(1, Math.min(count, frames.length) - 1))));
  const screen = new OffscreenCanvas(width, height);
  const draw = screen.getContext("2d")!;
  const patch = new OffscreenCanvas(1, 1);
  const patchDraw = patch.getContext("2d")!;
  const grabbed: Array<{ bitmap: ImageBitmap; at: number }> = [];
  let clock = 0;
  for (const [index, frame] of frames.entries()) {
    const { width: w, height: h, left, top } = frame.dims;
    const before = frame.disposalType === 3 ? draw.getImageData(0, 0, width, height) : null;
    patch.width = w;
    patch.height = h;
    patchDraw.putImageData(new ImageData(new Uint8ClampedArray(frame.patch), w, h), 0, 0);
    draw.drawImage(patch, left, top);
    if (picks.has(index)) grabbed.push({ bitmap: await createImageBitmap(screen), at: clock });
    // gifuct gives each frame's delay in milliseconds.
    clock += frame.delay;
    // How this frame is cleared before the next one.
    if (frame.disposalType === 2) draw.clearRect(left, top, w, h);
    else if (before) draw.putImageData(before, 0, 0);
  }

  // Lay them out: up to 3 across, each about 240px wide, numbered.
  const columns = Math.min(3, grabbed.length);
  const rows = Math.ceil(grabbed.length / columns);
  const cellWidth = Math.min(240, width);
  const cellHeight = Math.round((cellWidth * height) / width);
  const gap = 4;
  const sheet = new OffscreenCanvas(columns * cellWidth + (columns - 1) * gap, rows * cellHeight + (rows - 1) * gap);
  const paint = sheet.getContext("2d")!;
  paint.fillStyle = "#ffffff";
  paint.fillRect(0, 0, sheet.width, sheet.height);
  paint.font = "bold 13px sans-serif";
  grabbed.forEach(({ bitmap, at }, index) => {
    const x = (index % columns) * (cellWidth + gap);
    const y = Math.floor(index / columns) * (cellHeight + gap);
    paint.drawImage(bitmap, x, y, cellWidth, cellHeight);
    // Frame number and when it appears, e.g. "3 · 0.8s".
    const label = `${index + 1} · ${(at / 1000).toFixed(1)}s`;
    paint.fillStyle = "rgba(0,0,0,0.65)";
    paint.fillRect(x + 4, y + 4, paint.measureText(label).width + 12, 20);
    paint.fillStyle = "#ffffff";
    paint.fillText(label, x + 10, y + 19);
    bitmap.close();
  });
  const blob = await sheet.convertToBlob({ type: "image/jpeg", quality: 0.85 });
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let index = 0; index < buffer.length; index += 0x8000) binary += String.fromCharCode(...buffer.subarray(index, index + 0x8000));
  return btoa(binary);
}
