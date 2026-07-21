

import { AIRLINE_DOM_INNERTEXT_PROBES } from './airline-ocr-probes';

export const UNKNOWN_AIRLINE_DOM_LABEL = 'Перевозчик';

export type ListingParseSite = 'aviasales' | 'kupibilet';

const MIN_OFFER_RUB = 2_499;

const KUPI_DIRECT_START_EXTRA = ['Без пересадок', 'Прямой перелёт', 'Прямой перелет'] as const;

const COMMON_START_MARKERS = [
  'Прямые рейсы',
  'Прямые перелеты',
  'Direct flights',
] as const;

const SECTION_END_MARKERS = [

  '\nРейсы с пересад',
  '\nМы нашли билеты с пересад',
  '\nВсе билеты с пересадками',
] as const;

function normalizeWs(raw: string): string {
  return raw
    .replace(/\r/g, '')
    .replace(/\u00A0/g, ' ')
    .replace(/\u202f/g, ' ')
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function airlineProbeInText(prefixNorm: string): string | null {
  return getRightmostAirlineSpan(prefixNorm)?.label ?? null;
}

function getRightmostAirlineSpan(block: string): { label: string; end: number } | null {
  let bestLabel: string | null = null;
  let bestEnd = -1;
  let bestLen = -1;
  for (const p of AIRLINE_DOM_INNERTEXT_PROBES) {
    const flags = /\bg\b/.test(p.re.flags) ? p.re.flags : `${p.re.flags}g`;
    const r = new RegExp(p.re.source, flags);
    let m: RegExpExecArray | null;
    while ((m = r.exec(block)) !== null) {
      const end = m.index + m[0].length;
      const len = m[0].length;
      if (end > bestEnd || (end === bestEnd && len > bestLen)) {
        bestEnd = end;
        bestLen = len;
        bestLabel = p.label;
      }
    }
  }
  if (bestLabel == null || bestEnd < 0) return null;
  return { label: bestLabel, end: bestEnd };
}

function bestSectionStart(raw: string, markers: readonly string[]): {
  idx: number;
  len: number;
} | null {
  /** Предпочитаем заголовок, после которого скорее появляется имя перевозчика и чек с ₽. */
  let best: { idx: number; len: number; rank: number } | null = null;
  const rankWindow = (from: number, lenMarker: number): number => {
    const w = raw.slice(from, from + Math.min(2800, raw.length - from));
    const hasBigPrice = /(?:^|[\s\n])(?:\d{1,3}(?:[ \u202f\u00A0]\d{3})+|\d{4,})\s*₽/m.test(
      w.slice(lenMarker),
    );
    const hasAirSoon = airlineProbeInText(w.slice(lenMarker)) != null ? 4 : 0;
    let r = 0;
    if (hasBigPrice) r += 2;
    r += hasAirSoon;
    return r;
  };

  for (const marker of markers) {
    let from = 0;
    while (true) {
      const idx = raw.indexOf(marker, from);
      if (idx < 0) break;
      const rank = rankWindow(idx, marker.length);
      if (
        !best ||
        rank > best.rank ||
        (rank === best.rank && idx > best.idx)
      ) {
        best = { idx, len: marker.length, rank };
      }
      from = idx + marker.length;
    }
  }
  return best ? { idx: best.idx, len: best.len } : null;
}

/**
 * Вырезаем текст от лучшего заголовка «Прямые рейсы» до блока с пересадками.
 */
export function scopeListingInnerText(
  site: ListingParseSite,
  fullInnerText: string,
): string {
  const raw = normalizeWs(fullInnerText);
  const markers: readonly string[] =
    site === 'kupibilet'
      ? [...COMMON_START_MARKERS, ...KUPI_DIRECT_START_EXTRA]
      : [...COMMON_START_MARKERS];

  const chosen = bestSectionStart(raw, markers);
  if (!chosen) return raw.slice(Math.min(2800, Math.floor(raw.length * 0.08)));

  const start = chosen.idx;
  const usedLen = chosen.len;

  const after = raw.slice(start + usedLen);
  let endRel = after.length;
  for (const em of SECTION_END_MARKERS) {
    const j = after.indexOf(em);
    if (j >= 0 && j < endRel) endRel = j;
  }

  const segmentEnd = start + usedLen + endRel;
  let chunk =
    endRel >= after.length
      ? raw.slice(start, Math.min(raw.length, start + 22_000))
      : raw.slice(start, Math.min(segmentEnd, raw.length));

  if (site === 'kupibilet') chunk = narrowKupibiletCheapestFareBlock(chunk);
  return chunk;
}

/** Первое «осмысленное» место оффера: часы или крупная цена ₽ после якоря. */
function kupibiletFirstAnchoredListingOffset(s: string): number {
  const reRub =
    /(\d{1,3}(?:[ \u202f\u00A0]\d{3})+|\d{2,})\s*₽/g;
  let rubIdx = Number.POSITIVE_INFINITY;
  let mr: RegExpExecArray | null;
  while ((mr = reRub.exec(s)) !== null) {
    const amt = parseInt(mr[1].replace(/\D/g, ''), 10);
    if (amt >= MIN_OFFER_RUB) {
      rubIdx = mr.index ?? 0;
      break;
    }
  }

  const reClock =
    /\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/;
  const mc = reClock.exec(s);
  const timeIdx = mc?.index ?? Number.POSITIVE_INFINITY;

  const v = Math.min(rubIdx, timeIdx);
  return Number.isFinite(v) && v !== Number.POSITIVE_INFINITY ? v : -1;
}

/**
 * Сузить к первой дорогой карточке; не резать по «Самый быстрый», если он висит НА ЖЕЙ
 * карте вместе с «Самый дешёвый» (иначе теряются рейсы и сумма перед ₽ → левые числа со страницы).
 */
function narrowKupibiletCheapestFareBlock(scoped: string): string {
  const m = /\bСамый\s+деш[её]вый\b/i.exec(scoped);
  if (m?.index === undefined) return scoped;
  const tail = scoped.slice(m.index);

  const contentBeg = kupibiletFirstAnchoredListingOffset(tail);
  /** Нет времени и крупной ₽ после якоря — не режем по «быстром», может порвать вёрстку. */
  if (contentBeg < 0) {
    return tail.slice(0, 8200).trimEnd();
  }

  /** «Самый быстрый» на этой же карточке идёт ДО времени суммы → пропускаем; конец режем по след. «быстром» уже после данных. */
  let searchFrom = 0;
  while (searchFrom < tail.length) {
    const sub = tail.slice(searchFrom);
    const fm = /\bСамый\s+быстрый\b/i.exec(sub);
    if (!fm) break;

    const cutAbs = searchFrom + fm.index;
    if (cutAbs < contentBeg) {
      searchFrom = cutAbs + 14;
      continue;
    }

    return tail.slice(0, cutAbs).trimEnd();
  }

  return tail.slice(0, 8200).trimEnd();
}

const CLOCK_RX = /\b([01]?\d|2[0-3])[.:]([0-5]\d)\b/g;

/** В одну строку OW выводим несколько времён через запятую (как на выдаче). */
const MAX_OW_DEPARTURE_TIMES_SHOWN = 4;

function collectTimesInOrder(text: string): string[] {
  const re = new RegExp(CLOCK_RX.source, CLOCK_RX.flags);
  let m: RegExpExecArray | null;
  const times: string[] = [];
  while ((m = re.exec(text)) !== null) {
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (!Number.isFinite(hh) || !Number.isFinite(mm)) continue;
    const t = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (times.length === 0 || times[times.length - 1] !== t) times.push(t);
  }
  return times;
}

/**
 * Время вылета только из текста ПОСЛЕ названия перевозчика (иначе цепляется время строки выше).
 *
 * Kupibilet RT-карточка: два ряда (туда · обратно), в тексте часто подряд
 * вылет1 · прибытие1 · вылет2 · прибытие2 — берём вылеты с индексами 0 и 2.
 * Авиасейлс: иначе, остаётся старая эвристика «последние два времени».
 */
function departurePairRoundTripAfterAirline(
  site: ListingParseSite,
  times: string[],
): { outbound: string | null; ret: string | null } | null {
  if (times.length >= 4 && site === 'kupibilet') {
    return { outbound: times[0] ?? null, ret: times[2] ?? null };
  }
  if (times.length >= 2) {
    if (site === 'aviasales') {
      return {
        outbound: times[times.length - 2] ?? null,
        ret: times[times.length - 1] ?? null,
      };
    }
    /* Kupibilet: два времени без «полного» квада — туда и обратно один ряд каждый. */
    return { outbound: times[0] ?? null, ret: times[1] ?? null };
  }
  if (times.length === 1)
    return { outbound: times[0] ?? null, ret: null };
  return null;
}

function departureTimesAfterAirlineInBlock(
  site: ListingParseSite,
  blockBeforeRub: string,
  roundTrip: boolean,
  span?: { label: string; end: number } | null,
): { outbound: string | null; ret: string | null } {
  const s =
    span ?? getRightmostAirlineSpan(blockBeforeRub);

  /** Kupibilet: имена перевозчиков часто ниже времени по innerText; часы считаем по всему окну до ₽. */
  if (site === 'kupibilet') {
    const blob = collectTimesInOrder(blockBeforeRub);
    if (blob.length === 0) return { outbound: null, ret: null };
    if (roundTrip) {
      const pair = departurePairRoundTripAfterAirline(site, blob);
      return pair ?? { outbound: blob[0] ?? null, ret: null };
    }
    return { outbound: blob[0] ?? null, ret: null };
  }

  if (!s) return { outbound: null, ret: null };
  const suffix = blockBeforeRub.slice(s.end);
  const times = collectTimesInOrder(suffix);
  if (times.length === 0) return { outbound: null, ret: null };
  if (roundTrip) {
    const pair = departurePairRoundTripAfterAirline(site, times);
    if (pair) return pair;
    return { outbound: times[0] ?? null, ret: null };
  }

  const shown = times.slice(0, MAX_OW_DEPARTURE_TIMES_SHOWN);
  const outbound =
    shown.length <= 1 ? (shown[0] ?? null) : shown.join(', ');
  return { outbound, ret: null };
}

/** Строки «багаж 10 кг … 4 561 ₽», выбор места и т.п. — не основной тариф карточки. */
function isLikelyKupibiletAddonPrice(norm: string, rubStart: number): boolean {
  const lo = Math.max(0, rubStart - 220);
  const ctx = norm.slice(lo, rubStart);
  return (
    /\bбагаж\b/i.test(ctx) ||
    /\bстрахов/i.test(ctx) ||
    /\bмест[ауое]\s+(?:в\s+самол[её]те|выбора)\b/i.test(ctx) ||
    (/\bx\s*\d/i.test(ctx) && /\d+\s*(?:кг|кг\.)\b/i.test(ctx))
  );
}

/** Kupibilet: второй сегмент `route[1]=…` в query — классический туда‑обратно. */
export function kupibiletSearchIsRoundTrip(searchUrl: string): boolean {
  const raw = searchUrl.trim();
  try {
    const u = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (!u.hostname.toLowerCase().includes('kupibilet')) return false;
    const r1 = u.searchParams.get('route[1]')?.trim();
    return Boolean(r1 && r1.length > 12);
  } catch {
    return false;
  }
}

/** URL поиска Авиасейлс: туда‑обратно по структуре сегмента (…DDMM…DDMM…). */
export function aviasalesSearchIsRoundTrip(searchUrl: string): boolean {
  const raw = searchUrl.trim();
  const fromPath = /\/search\/([^?#]+)/i.exec(raw);
  let slug = fromPath?.[1];
  if (slug) {
    try {
      slug = decodeURIComponent(slug);
    } catch {
      /* */
    }
  }
  if (!slug) return false;
  const s = slug.trim().toUpperCase().replace(/^\/+|\/+$/g, '');
  return /^[A-Z]{3}\d{2}\d{2}[A-Z]{3}\d{2}\d{2}\d+$/u.test(s);
}

const BETWEEN_PRICES_HARD_MAX = 3_200;

/**
 * В innerText между концом названия перевозчика и очередным «NNN ₽» уже встретилась
 * другая сумма того же блока выдачи — значит очередное ₽ принадлежит календарю/виджету,
 * а не карточке этой АК (типично: Урал получал 6 679 вместо 11 973).
 */
function gapContainsDistinctListingRubBeforePrice(
  norm: string,
  carrierAbsEnd: number,
  rubStartExclusive: number,
  thisRubAmount: number,
): boolean {
  if (carrierAbsEnd >= rubStartExclusive) return false;
  const mid = norm.slice(carrierAbsEnd, rubStartExclusive);
  const re = /(\d{1,3}(?:[ \u202f\u00A0]\d{3})+|\d{2,})\s*₽/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(mid)) !== null) {
    const k = parseInt(m[1].replace(/\D/g, ''), 10);
    if (!Number.isFinite(k) || k < MIN_OFFER_RUB) continue;
    if (k !== thisRubAmount) return true;
  }
  return false;
}

/**
 * Между ближайшим ₽-суммами в innerText часто нет названия перевозчика.
 * Окно расширяем, но отбрасываем связку, если «хвост» АК до цены слишком длинный
 * или уже видна другая карточная сумма между ними.
 */
const PRICE_CARRIER_LOOKBACK_STEPS = [2_800, 5_600, 11_000, 22_000] as const;

/** Максимум символов от конца имени АК до этой суммы (кроме уже отфильтрованных случаев). */
const MAX_CHARS_BETWEEN_CARRIER_SUFFIX_AND_PRICE = 3_400;

/**
 * Старый кейс: один длинный кусок «все АК, потом цены» — между ₽ нет бренда,
 * но «правое» имя во всём префиксе одно; режем только хвост перед ценой.
 */
const AIRLINE_RESOLVE_TAIL_CHARS = 3_200;

function getAirlineSpanNearPriceEnd(block: string): { label: string; end: number } | null {
  if (block.length === 0) return null;
  const tailLen = Math.min(AIRLINE_RESOLVE_TAIL_CHARS, block.length);
  const tail = block.slice(block.length - tailLen);
  const inTail = getRightmostAirlineSpan(tail);
  if (inTail) {
    return {
      label: inTail.label,
      end: block.length - tailLen + inTail.end,
    };
  }
  return getRightmostAirlineSpan(block);
}

function tryResolvedUnknownCarrier(
  site: ListingParseSite,
  norm: string,
  rubStart: number,
  blockBetweenPrices: string,
  blockStartAbsInNorm: number,
  roundTrip: boolean,
): { carrier: string; departureTime: string | null; returnDepartureTime: string | null } | null {
  const len = Math.min(6_200, rubStart);
  const probe = rubStart <= 0 ? '' : norm.slice(rubStart - len, rubStart);
  if (getRightmostAirlineSpan(probe) != null) return null;

  const chunkLo = Math.max(blockStartAbsInNorm, rubStart - 2600);
  const chunk =
    chunkLo >= rubStart
      ? blockBetweenPrices
      : norm.slice(chunkLo, rubStart);
  const times = collectTimesInOrder(chunk.length >= 20 ? chunk : blockBetweenPrices);
  if (times.length === 0) return null;

  if (roundTrip) {
    const pair = departurePairRoundTripAfterAirline(site, times);
    if (pair) {
      return {
        carrier: UNKNOWN_AIRLINE_DOM_LABEL,
        departureTime: pair.outbound,
        returnDepartureTime: pair.ret,
      };
    }
    return {
      carrier: UNKNOWN_AIRLINE_DOM_LABEL,
      departureTime: null,
      returnDepartureTime: null,
    };
  }
  if (site === 'kupibilet' && times.length > 0) {
    return {
      carrier: UNKNOWN_AIRLINE_DOM_LABEL,
      departureTime: times[0] ?? null,
      returnDepartureTime: null,
    };
  }
  const shown = times.slice(0, MAX_OW_DEPARTURE_TIMES_SHOWN);
  const departureTime =
    shown.length <= 1 ? (shown[0] ?? null) : shown.join(', ');
  return {
    carrier: UNKNOWN_AIRLINE_DOM_LABEL,
    departureTime,
    returnDepartureTime: null,
  };
}

function carrierAndTimesBeforePrice(
  site: ListingParseSite,
  norm: string,
  rubStart: number,
  blockBetweenPrices: string,
  blockStartAbsInNorm: number,
  roundTrip: boolean,
  thisRubAmount: number,
): {
  carrier: string;
  departureTime: string | null;
  returnDepartureTime: string | null;
} | null {
  for (const w of PRICE_CARRIER_LOOKBACK_STEPS) {
    const len = Math.min(w, rubStart);
    if (len <= 0) continue;
    const ctxStart = rubStart - len;
    const ctx = norm.slice(ctxStart, rubStart);
    const span = getRightmostAirlineSpan(ctx);
    if (!span) continue;
    const carrierAbsEnd = ctxStart + span.end;
    const gapTail = rubStart - carrierAbsEnd;
    if (gapTail > MAX_CHARS_BETWEEN_CARRIER_SUFFIX_AND_PRICE) continue;
    if (
      gapContainsDistinctListingRubBeforePrice(
        norm,
        carrierAbsEnd,
        rubStart,
        thisRubAmount,
      )
    )
      continue;
    const { outbound, ret } = departureTimesAfterAirlineInBlock(
      site,
      ctx,
      roundTrip,
      span,
    );
    return {
      carrier: span.label,
      departureTime: outbound,
      returnDepartureTime: ret,
    };
  }

  const spanBp = getAirlineSpanNearPriceEnd(blockBetweenPrices);
  if (spanBp != null) {
    const carrierAbsEnd = blockStartAbsInNorm + spanBp.end;
    const gapTail = rubStart - carrierAbsEnd;
    if (
      gapTail <= MAX_CHARS_BETWEEN_CARRIER_SUFFIX_AND_PRICE &&
      !gapContainsDistinctListingRubBeforePrice(
        norm,
        carrierAbsEnd,
        rubStart,
        thisRubAmount,
      )
    ) {
      const { outbound, ret } = departureTimesAfterAirlineInBlock(
        site,
        blockBetweenPrices,
        roundTrip,
        spanBp,
      );
      return {
        carrier: spanBp.label,
        departureTime: outbound,
        returnDepartureTime: ret,
      };
    }
  }

  const unknown = tryResolvedUnknownCarrier(
    site,
    norm,
    rubStart,
    blockBetweenPrices,
    blockStartAbsInNorm,
    roundTrip,
  );
  if (unknown) return unknown;

  return null;
}

export interface ParsedOfferRow {
  carrier: string;
  price: number;
  departureTime: string | null;
  returnDepartureTime: string | null;
}

export function extractOfferRowsFromScopedListingText(
  scopedRaw: string,
  opts?: { roundTrip?: boolean; site?: ListingParseSite },
): ParsedOfferRow[] {
  const roundTrip = opts?.roundTrip === true;
  const site: ListingParseSite = opts?.site ?? 'aviasales';
  const norm = normalizeWs(scopedRaw);
  const gPrice =
    /(\d{1,3}(?:[ \u202f\u00A0]\d{3})+|\d{2,})\s*₽/g;

  const out: ParsedOfferRow[] = [];
  let m: RegExpExecArray | null;
  /** Сразу после предыдущей найденной ₽‑суммы (по тексту порядку). */
  let cursorAfterPrevRub = 0;

  while ((m = gPrice.exec(norm)) !== null) {
    const rubStart = m.index ?? 0;
    const rubEnd = rubStart + m[0].length;
    const n = parseInt(m[1].replace(/\D/g, ''), 10);
    if (!Number.isFinite(n) || n < MIN_OFFER_RUB || n > 10_000_000) {
      cursorAfterPrevRub = rubEnd;
      continue;
    }
    if (
      site === 'kupibilet' &&
      isLikelyKupibiletAddonPrice(norm, rubStart)
    ) {
      cursorAfterPrevRub = rubEnd;
      continue;
    }

    const gap = rubStart - cursorAfterPrevRub;
    const blockStart =
      gap > BETWEEN_PRICES_HARD_MAX ? rubStart - BETWEEN_PRICES_HARD_MAX : cursorAfterPrevRub;
    const block = norm.slice(blockStart, rubStart);

    cursorAfterPrevRub = rubEnd;

    const resolved = carrierAndTimesBeforePrice(
      site,
      norm,
      rubStart,
      block,
      blockStart,
      roundTrip,
      n,
    );
    if (resolved == null) continue;

    const { carrier, departureTime: outbound, returnDepartureTime: ret } = resolved;

    const prev = out[out.length - 1];
    if (
      prev &&
      prev.carrier === carrier &&
      prev.price === n &&
      (prev.departureTime ?? '') === (outbound ?? '') &&
      (prev.returnDepartureTime ?? '') === (ret ?? '')
    )
      continue;

    out.push({
      carrier,
      price: n,
      departureTime: outbound,
      returnDepartureTime: ret,
    });
  }

  return out;
}

/** Одна строка на перевозчика: минимальная цена из выдачи «прямых» (багаж/опции остаются дороже). */
export function preferOneCheapestPerCarrier(rows: ParsedOfferRow[]): ParsedOfferRow[] {
  const byCarrier = new Map<string, ParsedOfferRow>();
  const order: string[] = [];
  for (const r of rows) {
    if (!byCarrier.has(r.carrier)) {
      order.push(r.carrier);
      byCarrier.set(r.carrier, r);
      continue;
    }
    const cur = byCarrier.get(r.carrier)!;
    if (r.price < cur.price) byCarrier.set(r.carrier, r);
  }
  return order.map((c) => byCarrier.get(c)!);
}

export function carrierRowsFromPageInnerText(
  site: ListingParseSite,
  fullInnerText: string,
  searchUrl?: string,
): ParsedOfferRow[] {
  const scope = scopeListingInnerText(site, fullInnerText);
  const roundTrip =
    !!searchUrl &&
    ((site === 'aviasales' && aviasalesSearchIsRoundTrip(searchUrl)) ||
      (site === 'kupibilet' && kupibiletSearchIsRoundTrip(searchUrl)));
  const rows = extractOfferRowsFromScopedListingText(scope, {
    roundTrip,
    site,
  });
  return preferOneCheapestPerCarrier(rows);
}
