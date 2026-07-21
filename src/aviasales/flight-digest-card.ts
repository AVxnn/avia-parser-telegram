

import sharp from 'sharp';

export type FlightDigestCardInput = {

  routeTitle: string;

  datesLine: string;

  lines: string[];
};

const MAX_LINES = 9;
const MAX_LINE_CHARS = 96;

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function truncateLine(s: string, max = MAX_LINE_CHARS): string {
  const t = s.trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

/**
 * Композиция нижней панели с градиентом и текстом поверх входного JPEG.
 */
export async function compositeFlightDigestOnScreenshot(
  jpegBuffer: Buffer,
  input: FlightDigestCardInput,
): Promise<Buffer> {
  const meta = await sharp(jpegBuffer).metadata();
  const W = meta.width ?? 1200;
  const H = meta.height ?? Math.round(W * 0.56);

  const lines = input.lines
    .map((x) => truncateLine(x.replace(/\s+/g, ' ')))
    .filter(Boolean)
    .slice(0, MAX_LINES);

  const fontRoute = clamp(Math.round(W * 0.024), 22, 36);
  const fontDates = clamp(Math.round(W * 0.0165), 16, 24);
  const fontBody = clamp(Math.round(W * 0.0135), 13, 19);
  const linePitch = clamp(Math.round(fontBody * 1.38), 24, 40);

  const headerBlock = Math.round(fontRoute + fontDates + 56 + 36);
  const bodyH = Math.max(lines.length, 1) * linePitch + 24;
  const panelH = clamp(
    Math.min(Math.round(H * 0.48), headerBlock + bodyH),
    Math.round(H * 0.2),
    Math.round(H * 0.52),
  );

  const svg = buildOverlaySvg(
    W,
    panelH,
    fontRoute,
    fontDates,
    fontBody,
    linePitch,
    input.routeTitle,
    input.datesLine,
    lines,
  );

  return sharp(jpegBuffer)
    .composite([
      {
        input: Buffer.from(svg),
        gravity: sharp.gravity.south,
      },
    ])
    .jpeg({ quality: 84, mozjpeg: true })
    .toBuffer();
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function buildOverlaySvg(
  W: number,
  panelH: number,
  fontRoute: number,
  fontDates: number,
  fontBody: number,
  linePitch: number,
  routeTitle: string,
  datesLine: string,
  lines: string[],
): string {
  const padX = clamp(Math.round(W * 0.022), 20, 40);
  /** Базовая линия (baseline) строки заголовка. */
  const yRoute = clamp(Math.round(panelH * 0.2), 48, 86);
  const accentY = yRoute - fontRoute + 4;
  const accentX = padX;
  const accentW = clamp(Math.round(W * 0.068), 52, 96);

  const title = escapeXml(truncateLine(routeTitle, MAX_LINE_CHARS + 40));
  const dates = escapeXml(truncateLine(datesLine, MAX_LINE_CHARS + 40));

  const routeBlock = `
  <rect x="${accentX}" y="${accentY}" width="${accentW}" height="4" rx="2" fill="#22d3ee"/>
  <text x="${padX}" y="${yRoute}" fill="#f8fafc"
    font-family="system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"
    font-size="${fontRoute}" font-weight="700">${title}</text>`;

  const yDates = yRoute + Math.round(fontRoute * 0.35 + 22);
  const datesBlock = `
  <text x="${padX}" y="${yDates}" fill="#99f6e4"
    font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    font-size="${fontDates}" font-weight="600">${dates}</text>`;

  const bodyStartY = yDates + Math.round(fontDates + 32);

  let bodyTexts = '';
  if (lines.length === 0) {
    bodyTexts = `
    <text x="${padX}" y="${bodyStartY}" fill="#cbd5e1" font-weight="450"
      font-family="ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace"
      font-size="${fontBody}">${escapeXml('Нет сумм ₽ на выдаче')}</text>`;
  } else {
    lines.forEach((line, i) => {
      const y = bodyStartY + i * linePitch;
      bodyTexts += `
    <text x="${padX}" y="${y}" fill="#e2e8f0" font-weight="450"
      font-family="system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
      font-size="${fontBody}">${escapeXml(line)}</text>`;
    });
  }

  /* Вьюпорт точно совпадает с слоем снизу (sharp подставляет south). */
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${panelH}" viewBox="0 0 ${W} ${panelH}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="cardGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#020617" stop-opacity="0.18"/>
      <stop offset="35%" stop-color="#0f172a" stop-opacity="0.76"/>
      <stop offset="100%" stop-color="#020617" stop-opacity="0.97"/>
    </linearGradient>
  </defs>
  <rect width="${W}" height="${panelH}" fill="url(#cardGrad)"/>
  <rect width="${W}" height="5" fill="#38bdf8" fill-opacity="0.55"/>
  ${routeBlock}
  ${datesBlock}
  ${bodyTexts}
</svg>`;
}
