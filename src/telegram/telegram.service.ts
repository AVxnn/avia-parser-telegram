import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Context, Markup, Telegraf } from 'telegraf';
import { AviasalesScreenshotService } from '../aviasales/aviasales-screenshot.service';
import type {
  AviasalesVisualSnapshot,
  CarrierRubPrice,
} from '../aviasales/aviasales-visual.types';
import type { FlightDigestCardInput } from '../aviasales/flight-digest-card';
import { compositeFlightDigestOnScreenshot } from '../aviasales/flight-digest-card';
import { CitiesService } from '../cities/cities.service';
import { CheapestResult, PricesService } from '../prices/prices.service';
import { loadTelegramUxAssets, type TelegramUxAssets } from './telegram-ux.assets';

export type Ymd = { y: number; m: number; d: number };

export type NotifyPreference = 'on_change' | 'hourly';

const MIN_USER_DIGEST_INTERVAL_MS = 60_000;
const MAX_USER_DIGEST_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

const BTN_NOTIFY_ON_CHANGE = 'При изменении';
const BTN_NOTIFY_HOURLY = 'Интервал';

const BTN_SHOT_TEXT = 'Только текст';
const BTN_SHOT_SCREEN = 'Скриншот выдачи';

const BTN_SETTINGS = 'Настройки';
const BTN_MAIN_MENU = '◀️ Главное меню';

/** Ручная сводка по всем подпискам чата (анти‑спам: не чаще раз в 3 мин). */
const BTN_MANUAL_CHECK = '🔄 Пора проверить';
const MANUAL_CHECK_COOLDOWN_MS = 180_000;

/** Ошибка Telegram API (Telegraf может класть text в `.response`). */
function telegramErrorDescription(err: unknown): string {
  if (err instanceof Error) {
    const nested = (
      err as Error & {
        response?: { description?: string };
        parameters?: Record<string, unknown>;
      }
    ).response?.description?.trim?.();
    if (nested)
      return `${err.message}${nested !== err.message ? ` — ${nested}` : ''}`;
    return err.message || String(err);
  }
  if (typeof err === 'object' && err !== null && 'response' in err) {
    const desc = (
      err as { response?: { description?: string } }
    ).response?.description?.trim?.();
    if (desc?.length) return desc;
  }
  return String(err);
}

type FlightTicketSite = 'aviasales' | 'kupibilet';

const BTN_FLIGHT_SITE_AVIASALES = '✈️ Авиасейлс';
const BTN_FLIGHT_SITE_KUPIBILET = '🎟 Купибилет (бета)';

function flightSiteKeyboardLabels(
  site: FlightTicketSite,
): [string, string] {
  return [
    site === 'aviasales'
      ? `✅ ${BTN_FLIGHT_SITE_AVIASALES}`
      : BTN_FLIGHT_SITE_AVIASALES,
    site === 'kupibilet'
      ? `✅ ${BTN_FLIGHT_SITE_KUPIBILET}`
      : BTN_FLIGHT_SITE_KUPIBILET,
  ];
}

/** Один или два сегмента (route[0], route[1]…) в порядке индекса. */
function sortedKupibiletRouteTuples(
  u: URL,
): Array<{ idx: number; val: string }> {
  const out: Array<{ idx: number; val: string }> = [];
  for (const [k, val] of u.searchParams.entries()) {
    const kn = k.replace(/\s+/g, '');
    const m = /^route\[(\d+)\]$/i.exec(kn);
    if (!m || !val.trim()) continue;
    const idx = Number(m[1]);
    if (!Number.isFinite(idx)) continue;
    out.push({ idx, val: val.trim() });
  }
  out.sort((a, b) => a.idx - b.idx);
  return out;
}

function buildKupibiletSearchUrl(
  originCode: string,
  destCode: string,
  ymdOut: Ymd,
  ymdReturn: Ymd | null,
): string {
  const o = originCode.toUpperCase();
  const d = destCode.toUpperCase();
  const dsOut = `${ymdOut.y}-${pad2(ymdOut.m)}-${pad2(ymdOut.d)}`;
  const routeOut = `iatax:${o}_${dsOut}_date_${dsOut}_iatax:${d}`;
  const p = new URLSearchParams();
  p.set('adult', '1');
  p.set('cabinClass', 'Y');
  p.set('child', '0');
  p.append('childrenAges', '[]');
  p.set('infant', '0');
  p.set('source', 'null');
  p.set('v', '2');
  p.set(
    'filter',
    JSON.stringify({ transportKind: { Airplane: true } }),
  );
  p.append('route[0]', routeOut);
  if (ymdReturn != null) {
    const dsRet = `${ymdReturn.y}-${pad2(ymdReturn.m)}-${pad2(ymdReturn.d)}`;
    const routeRet = `iatax:${d}_${dsRet}_date_${dsRet}_iatax:${o}`;
    p.append('route[1]', routeRet);
  }
  return `https://www.kupibilet.ru/search?${p.toString()}`;
}

function looksLikeKupibiletFlightUrl(raw: string): boolean {
  const s = raw.trim();
  if (/^https?:\/\//i.test(s)) {
    try {
      return new URL(s).hostname.toLowerCase().includes('kupibilet');
    } catch {
      return false;
    }
  }
  return /\bkupibilet\.(?:ru|com)/i.test(s);
}

/** Первый сегмент маршрута (для обратной совместимости). */
function extractKupibiletRouteToken(rawUrl: string): string | null {
  let u: URL;
  try {
    u = new URL(
      /^https?:\/\//i.test(rawUrl.trim())
        ? rawUrl.trim()
        : `https://${rawUrl.trim()}`,
    );
  } catch {
    return null;
  }
  if (!u.hostname.toLowerCase().includes('kupibilet')) return null;
  const tuples = sortedKupibiletRouteTuples(u);
  return tuples[0]?.val ?? u.searchParams.get('route[0]')?.trim() ?? null;
}

function parseKupibiletRouteToken(
  tok: string,
): { originCode: string; destCode: string; ymd: Ymd } | null {
  const m =
    /^iatax:([A-Za-z]{3})_(\d{4}-\d{2}-\d{2})_date_\d{4}-\d{2}-\d{2}_iatax:([A-Za-z]{3})$/iu.exec(
      tok.trim(),
    );
  if (!m) return null;
  const ymd = parseDateToken(m[2]);
  if (!ymd) return null;
  return {
    originCode: m[1].toUpperCase(),
    destCode: m[3].toUpperCase(),
    ymd,
  };
}

/** Популярные города для пошаговой подписки (два шага с городами). */
const POPULAR_CITY_ROWS: string[][] = [
  ['Санкт-Петербург', 'Москва'],
  ['Екатеринбург', 'Казань', 'Сургут'],
];

const BTN_WIZARD_CANCEL = 'Отмена';

const BTN_DATE_TODAY = 'Сегодня';
const BTN_DATE_TOMORROW = 'Завтра';
const BTN_DATE_AFTER_TMRW = 'Послезавтра';
const BTN_DATE_PLUS_WEEK = 'Через неделю';
const BTN_DATE_PLUS_MONTH = 'Через месяц';
const BTN_DATE_CUSTOM = 'Кастомный ввод';
const BTN_DATE_BACK_PRESETS = '◀️ К пресетам';

const BTN_TRIP_ONEWAY = '✈️ Только туда';
const BTN_TRIP_ROUND = '🔁 Туда‑обратно';

const BTN_RETURN_PLUS_3 = 'Обратно: +3 дня';
const BTN_RETURN_PLUS_7 = 'Обратно: +7 дней';
const BTN_RETURN_PLUS_14 = 'Обратно: +14 дней';
const BTN_RETURN_DATE_CUSTOM = 'Своя дата обратно';
const BTN_RETURN_BACK_SHAPE = '◀️ Изменить дату «туда»';

const SUBSCRIBE_WIZARD_MSK_TZ = 'Europe/Moscow';

const SUBSCRIBE_DATE_PRESET_ROWS: string[][] = [
  [BTN_DATE_TODAY, BTN_DATE_TOMORROW],
  [BTN_DATE_AFTER_TMRW, BTN_DATE_PLUS_WEEK],
  [BTN_DATE_PLUS_MONTH, BTN_DATE_CUSTOM],
];

/** Inline callback d:XXX — допустимые значения миллисекунд */
const DIGEST_PRESET_CALLBACK_MS = new Set([
  60_000,
  300_000,
  600_000,
  1_800_000,
  3_600_000,
  21_600_000,
]);

/** Inline-кнопка «Подписаться» под подсказкой «Как подписаться». */
const CB_SUBSCRIBE_WIZARD = 'wiz:subscribe';

/** Старый текст кнопки режима до переименования в «Интервал». */
const LEGACY_BTN_NOTIFY_HOURLY = 'Раз в час';

/** Для `Telegraf.hears(TriggerFn)` требуется `RegExpExecArray | null`. */
const HEAR_MATCH_DUMMY = /.*/;
const dummyHearMatchResult = HEAR_MATCH_DUMMY.exec('')!;

function subscribeHowtoInlineMarkup() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('📍 Подписаться', CB_SUBSCRIBE_WIZARD)],
  ]);
}

/** Убирает ведущий «галочковый» эмодзи у подписей reply-клавиатуры (разные клиенты). */
function stripLeadingSuccessEmoji(text: string): string {
  return text
    .trim()
    .replace(/^[\u2705\u2714]\uFE0F?\s*/u, '')
    .trim();
}

/** Быстрый выбор интервала сводок под сообщением. */
function digestPresetInlineMarkup() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback('1 мин', 'd:60000'),
      Markup.button.callback('5 мин', 'd:300000'),
      Markup.button.callback('10 мин', 'd:600000'),
    ],
    [
      Markup.button.callback('30 мин', 'd:1800000'),
      Markup.button.callback('1 ч', 'd:3600000'),
      Markup.button.callback('6 ч', 'd:21600000'),
    ],
  ]);
}

function notifyPrefKeyboardLabel(pref: NotifyPreference): [string, string] {
  return [
    pref === 'on_change' ? `✅ ${BTN_NOTIFY_ON_CHANGE}` : BTN_NOTIFY_ON_CHANGE,
    pref === 'hourly' ? `✅ ${BTN_NOTIFY_HOURLY}` : BTN_NOTIFY_HOURLY,
  ];
}

type ParsedSubscribe = {
  originCode: string;
  destCode: string;
  displayO: string;
  displayD: string;
  /** Дата вылета «туда». */
  ymd: Ymd;
  /** Дата рейса «обратно»; одна подписка включает оба направления. */
  returnYmd: Ymd | null;
};

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function parseDateToken(t: string): Ymd | null {
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) {
    const y = Number(iso[1]);
    const m = Number(iso[2]);
    const d = Number(iso[3]);
    return validYmd(y, m, d) ? { y, m, d } : null;
  }
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(t);
  if (ru) {
    const d = Number(ru[1]);
    const m = Number(ru[2]);
    const y = Number(ru[3]);
    return validYmd(y, m, d) ? { y, m, d } : null;
  }
  return null;
}

function validYmd(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m - 1 &&
    dt.getUTCDate() === d
  );
}

function ymdToIso(ymd: Ymd): string {
  return `${ymd.y}-${pad2(ymd.m)}-${pad2(ymd.d)}`;
}

function daysInGregorianMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function calendarYmdInTz(now: Date, timeZone: string): Ymd {
  const iso = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
  const parts = iso.split('-').map(Number);
  const y = parts[0]!;
  const mo = parts[1]!;
  const d = parts[2]!;
  return { y, m: mo, d };
}

function calendarAddDays(ymd: Ymd, delta: number): Ymd {
  let y = ymd.y;
  let m = ymd.m;
  let d = ymd.d + delta;
  for (;;) {
    const dim = daysInGregorianMonth(y, m);
    if (d >= 1 && d <= dim) return { y, m, d };
    if (d > dim) {
      d -= dim;
      m++;
      if (m > 12) {
        m = 1;
        y++;
      }
      continue;
    }
    m--;
    if (m < 1) {
      m = 12;
      y--;
    }
    d += daysInGregorianMonth(y, m);
  }
}

function calendarAddMonths(ymd: Ymd, add: number): Ymd {
  let y = ymd.y;
  let m = ymd.m + add;
  while (m > 12) {
    m -= 12;
    y++;
  }
  while (m < 1) {
    m += 12;
    y--;
  }
  const dim = daysInGregorianMonth(y, m);
  return { y, m, d: Math.min(ymd.d, dim) };
}

function subscribeDatePresetFromLabel(label: string): Ymd | null {
  const today = calendarYmdInTz(new Date(), SUBSCRIBE_WIZARD_MSK_TZ);
  switch (label.trim()) {
    case BTN_DATE_TODAY:
      return today;
    case BTN_DATE_TOMORROW:
      return calendarAddDays(today, 1);
    case BTN_DATE_AFTER_TMRW:
      return calendarAddDays(today, 2);
    case BTN_DATE_PLUS_WEEK:
      return calendarAddDays(today, 7);
    case BTN_DATE_PLUS_MONTH:
      return calendarAddMonths(today, 1);
    default:
      return null;
  }
}

function buildAviasalesListingSegment(
  origin: string,
  dest: string,
  yOut: Ymd,
  yRet: Ymd | null,
): string {
  const o = origin.toUpperCase();
  const d = dest.toUpperCase();
  const out = `${pad2(yOut.d)}${pad2(yOut.m)}`;
  if (!yRet) return `${o}${out}${d}1`;
  return `${o}${out}${d}${pad2(yRet.d)}${pad2(yRet.m)}1`;
}

function aviasalesUrl(segment: string): string {
  return `https://www.aviasales.ru/search/${segment}`;
}

type AviasalesSlugTripParsed =
  | {
      rt: false;
      originCode: string;
      destCode: string;
      outDay: number;
      outMonth: number;
    }
  | {
      rt: true;
      originCode: string;
      destCode: string;
      outDay: number;
      outMonth: number;
      retDay: number;
      retMonth: number;
    };

/** LED1505SVX1 (туда) или LED1505SVX18051 (туда‑обратно: ДДММ возврата + хвост, обычно «1»). */
function parseAviasalesSlugStructure(slug: string): AviasalesSlugTripParsed | null {
  const s = slug.trim().toUpperCase().replace(/^\/+|\/+$/g, '');
  const rt = /^([A-Z]{3})(\d{2})(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d+)$/u.exec(
    s,
  );
  if (rt) {
    const originCode = rt[1];
    const outDay = Number(rt[2]);
    const outMonth = Number(rt[3]);
    const destCode = rt[4];
    const retDay = Number(rt[5]);
    const retMonth = Number(rt[6]);
    if (
      !Number.isFinite(outDay) ||
      !Number.isFinite(outMonth) ||
      !Number.isFinite(retDay) ||
      !Number.isFinite(retMonth)
    )
      return null;
    if (
      outMonth < 1 ||
      outMonth > 12 ||
      retMonth < 1 ||
      retMonth > 12 ||
      outDay < 1 ||
      outDay > 31 ||
      retDay < 1 ||
      retDay > 31
    )
      return null;
    if (originCode === destCode) return null;
    return {
      rt: true,
      originCode,
      destCode,
      outDay,
      outMonth,
      retDay,
      retMonth,
    };
  }

  const ow = /^([A-Z]{3})(\d{2})(\d{2})([A-Z]{3})(\d*)$/u.exec(s);
  if (!ow) return null;
  const originCode = ow[1];
  const outDay = Number(ow[2]);
  const outMonth = Number(ow[3]);
  const destCode = ow[4];
  if (!Number.isFinite(outDay) || !Number.isFinite(outMonth)) return null;
  if (outMonth < 1 || outMonth > 12 || outDay < 1 || outDay > 31) return null;
  if (originCode === destCode) return null;
  return {
    rt: false,
    originCode,
    destCode,
    outDay,
    outMonth,
  };
}

function extractAviasalesSearchSlug(raw: string): string | null {
  const t = raw
    .replace(/\ufeff|\u200B/g, '')
    .trim()
    .replace(/^["'«„‹\s<(]+/, '')
    .replace(/["'»”›)>\s]+$/, '')
    .trim();

  const hostSlug = /aviasales\.(?:ru|com)\/+[^?\s#]*?\/?(?:search\/+)([^?\s#]+)/i.exec(t);
  if (hostSlug?.[1]?.length) {
    try {
      return decodeURIComponent(hostSlug[1])
        .replace(/^\/+|\/+$/g, '')
        .trim();
    } catch {
      return hostSlug[1].replace(/^\/+|\/+$/g, '').trim();
    }
  }

  const nakedPath = /^\/+search\/+([^?\s#]+)$/i.exec(t);
  if (nakedPath?.[1]?.length)
    try {
      return decodeURIComponent(nakedPath[1]).trim();
    } catch {
      return nakedPath[1].trim();
    }

  const relSearch = /^search\/+([^?\s#]+)$/i.exec(t);
  if (relSearch?.[1]?.length)
    try {
      return decodeURIComponent(relSearch[1]).trim();
    } catch {
      return relSearch[1].trim();
    }

  const compact = t.replace(/\s+/g, '').toUpperCase();
  if (/^[A-Z]{3}\d{4}[A-Z]{3}\d*$/u.test(compact)) return compact;

  return null;
}

function ymdSortKey(z: Ymd): number {
  return z.y * 10_000 + z.m * 100 + z.d;
}

/** В короткой ссылке только день+месяц — выбираем ближайшую календарную дату не раньше сегодня (МСК). */
function ymdFromDdMmPreferFuture(dm: { d: number; m: number }, today: Ymd): Ymd | null {
  for (let yi = 0; yi <= 8; yi++) {
    const y = today.y + yi;
    if (!validYmd(y, dm.m, dm.d)) continue;
    const cand: Ymd = { y, m: dm.m, d: dm.d };
    if (ymdSortKey(cand) >= ymdSortKey(today)) return cand;
  }
  return null;
}

function splitTelegramPlainChunks(text: string, maxLen = 3700): string[] {
  if (text.length <= maxLen) return [text];
  const out: string[] = [];
  for (let i = 0; i < text.length; i += maxLen)
    out.push(text.slice(i, i + maxLen));
  return out;
}

function dedupeParsedSubscribe(xs: ParsedSubscribe[]): ParsedSubscribe[] {
  const seen = new Set<string>();
  const out: ParsedSubscribe[] = [];
  for (const s of xs) {
    const k = `${s.originCode}-${s.destCode}-${ymdToIso(s.ymd)}-${s.returnYmd ? ymdToIso(s.returnYmd) : 'ow'}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out;
}

function screenshotPrefKeyboardLabels(
  screenshotOn: boolean,
): [string, string] {
  return [
    !screenshotOn ? `✅ ${BTN_SHOT_TEXT}` : BTN_SHOT_TEXT,
    screenshotOn ? `✅ ${BTN_SHOT_SCREEN}` : BTN_SHOT_SCREEN,
  ];
}

function buildReplyKeyboardFromRows(
  rows: string[][],
  placeholder?: string,
) {
  return Markup.keyboard(rows)
    .resize()
    .placeholder(placeholder ?? 'Сообщение…');
}

function wizardReplyKeyboard(rows: string[][]) {
  return buildReplyKeyboardFromRows(rows, 'Город или дата…');
}

function compactMainKeyboardRows(): string[][] {
  return [
    ['🛫 Как подписаться', '📍 Подписаться'],
    ['📋 Мои подписки', BTN_MANUAL_CHECK],
    [BTN_SETTINGS],
  ];
}

function settingsKeyboardRows(
  pref: NotifyPreference,
  screenshotOn: boolean,
  flightSite: FlightTicketSite,
): string[][] {
  const [a, b] = notifyPrefKeyboardLabel(pref);
  const [sOff, sOn] = screenshotPrefKeyboardLabels(screenshotOn);
  const [aso, kub] = flightSiteKeyboardLabels(flightSite);
  return [
    [a, b],
    [sOff, sOn],
    [aso, kub],
    ['🔕 Снять все подписки'],
    [BTN_MAIN_MENU],
  ];
}

/** Кнопки reply-клавиатуры — при нажатии во время диалога отменяем шаг подписки и отдаём update дальше. */
function isReplyMainKeyboardText(t: string): boolean {
  const s = t.trim();
  const base = stripLeadingSuccessEmoji(s);
  if (
    base === BTN_NOTIFY_ON_CHANGE ||
    base === BTN_NOTIFY_HOURLY ||
    base === BTN_SHOT_TEXT ||
    base === BTN_SHOT_SCREEN ||
    base === BTN_FLIGHT_SITE_AVIASALES ||
    base === BTN_FLIGHT_SITE_KUPIBILET ||
    base === LEGACY_BTN_NOTIFY_HOURLY ||
    base === BTN_TRIP_ONEWAY ||
    base === BTN_TRIP_ROUND ||
    base === BTN_RETURN_PLUS_3 ||
    base === BTN_RETURN_PLUS_7 ||
    base === BTN_RETURN_PLUS_14 ||
    base === BTN_RETURN_DATE_CUSTOM ||
    base === BTN_RETURN_BACK_SHAPE ||
    base === BTN_SETTINGS ||
    base === BTN_MAIN_MENU ||
    base === BTN_MANUAL_CHECK
  )
    return true;
  switch (s) {
    case '🛫 Как подписаться':
    case 'Как подписаться':
    case '📍 Подписаться':
    case 'Подписаться':
    case BTN_NOTIFY_ON_CHANGE:
    case BTN_NOTIFY_HOURLY:
    case `✅ ${BTN_NOTIFY_ON_CHANGE}`:
    case `✅ ${BTN_NOTIFY_HOURLY}`:
    case BTN_SHOT_TEXT:
    case BTN_SHOT_SCREEN:
    case `✅ ${BTN_SHOT_TEXT}`:
    case `✅ ${BTN_SHOT_SCREEN}`:
    case BTN_FLIGHT_SITE_AVIASALES:
    case BTN_FLIGHT_SITE_KUPIBILET:
    case `✅ ${BTN_FLIGHT_SITE_AVIASALES}`:
    case `✅ ${BTN_FLIGHT_SITE_KUPIBILET}`:
    case BTN_TRIP_ONEWAY:
    case BTN_TRIP_ROUND:
    case BTN_RETURN_PLUS_3:
    case BTN_RETURN_PLUS_7:
    case BTN_RETURN_PLUS_14:
    case BTN_RETURN_DATE_CUSTOM:
    case BTN_RETURN_BACK_SHAPE:
    case '📋 Мои подписки':
    case 'Мои подписки':
    case BTN_MANUAL_CHECK:
    case 'Пора проверить':
    case '🔕 Снять все подписки':
    case 'Снять все подписки':
    case BTN_SETTINGS:
    case BTN_MAIN_MENU:
    case LEGACY_BTN_NOTIFY_HOURLY:
    case `✅ ${LEGACY_BTN_NOTIFY_HOURLY}`:
      return true;
    default:
      return false;
  }
}

/** Справа находим суффикс-дату, всё что слева — города через пробел; перебираем разрезы «откуда / куда». */
function enumerateSpaceSeparatedSubscribe(
  rest: string,
): { originRaw: string; destRaw: string; dateRaw: string }[] {
  const tokens = rest
    .trim()
    .split(/\s+/)
    .filter((x) => x.length > 0);
  if (tokens.length < 3) return [];

  let dateStart = -1;
  for (let k = tokens.length - 1; k >= 0; k--) {
    const tail = tokens.slice(k).join(' ');
    if (parseDateToken(tail)) {
      dateStart = k;
      break;
    }
  }
  if (dateStart < 2) return [];

  const cities = tokens.slice(0, dateStart);
  const dateRaw = tokens.slice(dateStart).join(' ');
  if (!parseDateToken(dateRaw)) return [];

  const out: { originRaw: string; destRaw: string; dateRaw: string }[] = [];
  for (let i = 1; i < cities.length; i++) {
    const originRaw = cities.slice(0, i).join(' ');
    const destRaw = cities.slice(i).join(' ');
    if (originRaw.length < 2 || destRaw.length < 2) continue;
    if (originRaw.toLowerCase() === destRaw.toLowerCase()) continue;
    out.push({ originRaw, destRaw, dateRaw });
  }
  return out;
}

function inlinePurchaseAndUnsubscribe(bookingUrl: string, subscriptionId: number) {
  return Markup.inlineKeyboard([
    [Markup.button.url('Билет', bookingUrl)],
    [Markup.button.callback('Отписаться', `u:${subscriptionId}`)],
  ]);
}

/** Снимок состояния Cheap API для сравнения «до / после». */
type CheapMonitorState =
  | { k: 'e'; t: string }
  | { k: 'o' }
  | { k: 'p'; v: number };

function cloneCarrierPrices(xs: CarrierRubPrice[]): CarrierRubPrice[] {
  return xs.map((c) => ({
    carrier: c.carrier,
    price: c.price,
    departureTime: c.departureTime ?? null,
    returnDepartureTime: c.returnDepartureTime ?? null,
  }));
}

function normalizeCarriers(carriers?: CarrierRubPrice[]): CarrierRubPrice[] {
  if (!carriers || carriers.length === 0) return [];
  return carriers;
}

function departureLooselyEq(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  return (a ?? '').trim() === (b ?? '').trim();
}

function pickPriorCarrierRowIndex(
  prior: CarrierRubPrice[],
  c: CarrierRubPrice,
  usedPrior: Set<number>,
): number | null {
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < prior.length; i++) {
      if (usedPrior.has(i)) continue;
      if (prior[i].carrier !== c.carrier) continue;
      if (pass === 0) {
        if (
          departureLooselyEq(prior[i].departureTime, c.departureTime) &&
          departureLooselyEq(
            prior[i].returnDepartureTime,
            c.returnDepartureTime,
          )
        )
          return i;
      } else return i;
    }
  }
  return null;
}

function annotateRtDepartures(
  outWas?: string | null,
  outNow?: string | null,
  retWas?: string | null,
  retNow?: string | null,
): string {
  const ow = (outWas ?? '').trim();
  const on = (outNow ?? '').trim();
  const rw = (retWas ?? '').trim();
  const rn = (retNow ?? '').trim();
  if (ow === on && rw === rn) return '';
  const bits: string[] = [];
  if ((ow || on) && ow !== on) bits.push(`туда ${ow || '?'}→${on || '?'}`);
  if ((rw || rn) && rw !== rn) bits.push(`обратно ${rw || '?'}→${rn || '?'}`);
  return bits.length > 0 ? ` · ${bits.join(' · ')}` : '';
}

function formatCarrierOfferLineRu(
  c: CarrierRubPrice,
  fmtRubFn: (n: number) => string,
): string {
  const price = c.price != null ? fmtRubFn(c.price) : '—';
  const ot = (c.departureTime ?? '').trim();
  const rt = (c.returnDepartureTime ?? '').trim();
  const parts = [c.carrier];
  if (ot && rt) parts.push(`туда ${ot} · обратно ${rt}`);
  else if (ot) parts.push(`вылет ${ot}`);
  else if (rt) parts.push(`обратно ${rt}`);
  parts.push(price);
  return parts.join(' · ');
}

function clockAnnotMove(
  clkWas?: string | null,
  clkNow?: string | null,
): string {
  const a = (clkWas ?? '').trim();
  const b = (clkNow ?? '').trim();
  if (!a && !b) return '';
  if (a && b && a !== b) return ` · вылет ${a}→${b}`;
  return ` · вылет ${b || a}`;
}

function moveAnnotDepartures(
  oWas?: string | null,
  oNow?: string | null,
  rWas?: string | null,
  rNow?: string | null,
): string {
  const rw = (rWas ?? '').trim();
  const rn = (rNow ?? '').trim();
  if (rw !== '' || rn !== '') return annotateRtDepartures(oWas, oNow, rWas, rNow);
  return clockAnnotMove(oWas, oNow);
}

function describeCarrierPriceMoves(
  prior: CarrierRubPrice[],
  current: CarrierRubPrice[],
  fmtRubFn: (n: number) => string,
): string[] {
  const usedPrior = new Set<number>();
  const lines: string[] = [];

  for (const c of current) {
    const pi = pickPriorCarrierRowIndex(prior, c, usedPrior);
    const pRow =
      pi != null
        ? prior[pi]
        : {
            carrier: c.carrier,
            price: null as number | null,
            departureTime: null as string | null,
            returnDepartureTime: null as string | null,
          };
    if (pi != null) usedPrior.add(pi);
    const line = describeOneCarrierMove(
      c.carrier,
      pRow.price,
      c.price,
      fmtRubFn,
      pRow.departureTime,
      c.departureTime,
      pRow.returnDepartureTime,
      c.returnDepartureTime,
    );
    if (line) lines.push(line);
  }

  for (let i = 0; i < prior.length; i++) {
    if (usedPrior.has(i)) continue;
    const p = prior[i];
    const line = describeOneCarrierMove(
      p.carrier,
      p.price,
      null,
      fmtRubFn,
      p.departureTime,
      null,
      p.returnDepartureTime,
      null,
    );
    if (line) lines.push(line);
  }

  return lines;
}

function describeOneCarrierMove(
  name: string,
  was: number | null,
  now: number | null,
  fmtRubFn: (n: number) => string,
  outWas?: string | null,
  outNow?: string | null,
  retWas?: string | null,
  retNow?: string | null,
): string | null {
  const mv = moveAnnotDepartures(outWas, outNow, retWas, retNow);

  if (was === now) {
    if (!mv) return null;
    const p = now ?? was;
    const priceBit = p != null ? ` · цена ${fmtRubFn(p)}` : '';
    return `${name}: в выдаче другое время${mv}${priceBit}`;
  }

  if (was == null && now != null) {
    return `${name}: появилась цена ${fmtRubFn(now)}${mv}`;
  }
  if (was != null && now == null) {
    return `${name}: цена пропала (ранее ${fmtRubFn(was)})${mv}`;
  }
  if (was != null && now != null) {
    const d = now - was;
    const abs = Math.abs(d);
    const absStr = `${abs.toLocaleString('ru-RU')} ₽`;
    if (d > 0) {
      return `${name}: цена стала больше — было ${fmtRubFn(was)}, стало ${fmtRubFn(now)} (+${absStr})${mv}`;
    }
    return `${name}: цена стала меньше — было ${fmtRubFn(was)}, стало ${fmtRubFn(now)} (−${absStr})${mv}`;
  }
  return null;
}

function snapshotCheap(r: CheapestResult): CheapMonitorState {
  if (!r.success)
    return { k: 'e', t: String(r.error ?? 'ошибка API').slice(0, 280) };
  if (r.price == null) return { k: 'o' };
  return { k: 'p', v: r.price };
}

/** Время из ISO оффера Cheap API для подписи (МСК). */
function cheapOfferDepartureRuMsk(iso: unknown): string | null {
  if (typeof iso !== 'string' || !iso.trim()) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return (
    new Intl.DateTimeFormat('ru-RU', {
      timeZone: 'Europe/Moscow',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
      .format(d)
      // «15.05., 06:05» или с запятой без лишней точки
      .replace(/\s+/g, ' ')
      .trim() + ' МСК'
  );
}

/** Одна строка для сводки/ручной проверки (Cheap API по одному перелёту). */
function formatCheapApiOfferRu(
  r: CheapestResult,
  fmtRub: (n: number) => string,
): string {
  const snap = snapshotCheap(r);
  if (snap.k === 'e')
    return `Cheap API: ошибка · ${snap.t}`;
  if (snap.k === 'o')
    return 'Cheap API: в кэше нет предложений на эту дату';

  const o = r.offer as Record<string, unknown> | null | undefined;
  const parts: string[] = [];

  const air =
    o && typeof o.airline === 'string' && o.airline.trim().length > 0
      ? o.airline.trim().toUpperCase()
      : null;
  if (air) parts.push(air);

  const fn = o?.flight_number;
  if (
    fn !== undefined &&
    fn !== null &&
    String(fn).trim() !== ''
  )
    parts.push(`рейс ${String(fn)}`);

  const dep = cheapOfferDepartureRuMsk(o?.departure_at ?? null);
  if (dep) parts.push(`вылет ${dep}`);

  parts.push(fmtRub(snap.v));

  return `Cheap API · ${parts.join(' · ')}`;
}

function cheapStatesEqual(a: CheapMonitorState, b: CheapMonitorState): boolean {
  if (a.k !== b.k) return false;
  if (a.k === 'p' && b.k === 'p') return a.v === b.v;
  if (a.k === 'e' && b.k === 'e') return a.t === b.t;
  return true;
}

function explainCheapChange(
  from: CheapMonitorState,
  to: CheapMonitorState,
  fmtRubFn: (n: number) => string,
): string | null {
  if (cheapStatesEqual(from, to)) return null;
  if (from.k === 'p' && to.k === 'p' && from.v !== to.v) {
    const d = to.v - from.v;
    const absStr = `${Math.abs(d).toLocaleString('ru-RU')} ₽`;
    if (d > 0) {
      return `Cheap API: цена стала больше — было ${fmtRubFn(from.v)}, стало ${fmtRubFn(to.v)} (+${absStr})`;
    }
    return `Cheap API: цена стала меньше — было ${fmtRubFn(from.v)}, стало ${fmtRubFn(to.v)} (−${absStr})`;
  }
  if (from.k === 'p' && to.k !== 'p') {
    if (to.k === 'o') return `Cheap API: предложений в кэше больше нет (ранее ${fmtRubFn(from.v)})`;
    if (to.k === 'e') return `Cheap API: ошибка — было ${fmtRubFn(from.v)}, теперь: ${to.t}`;
    return null;
  }
  if (from.k !== 'p' && to.k === 'p') {
    if (from.k === 'o') return `Cheap API: появилась цена ${fmtRubFn(to.v)}`;
    if (from.k === 'e') return `Cheap API: снова есть цена ${fmtRubFn(to.v)} (до этого: ${from.t})`;
    return null;
  }
  if (from.k === 'e' && to.k === 'e' && from.t !== to.t) {
    return `Cheap API (ошибка): было «${from.t}», стало «${to.t}»`;
  }
  return `Cheap API: обновление выдачи (сравните вручную на Авиасейлс)`;
}

function minPositiveCarrierPrice(carriers: CarrierRubPrice[]): number | null {
  let best: number | null = null;
  for (const c of carriers) {
    const p = c.price;
    if (p != null && Number.isFinite(p)) {
      if (best === null || p < best) best = p;
    }
  }
  return best;
}

/** Если все пороги null — любое изменение блоков считается событием. Иначе: логика «или». */
function passesCarrierPriceAlerts(
  alertMaxRub: number | null,
  alertMinDropRub: number | null,
  alertMinDropPercent: number | null,
  prior: CarrierRubPrice[],
  current: CarrierRubPrice[],
): boolean {
  if (
    alertMaxRub == null &&
    alertMinDropRub == null &&
    alertMinDropPercent == null
  )
    return true;

  const prevMin = minPositiveCarrierPrice(prior);
  const currMin = minPositiveCarrierPrice(current);
  let hit = false;
  if (alertMaxRub != null && currMin != null && currMin <= alertMaxRub)
    hit = true;
  if (
    alertMinDropRub != null &&
    prevMin != null &&
    currMin != null &&
    prevMin - currMin >= alertMinDropRub
  )
    hit = true;
  if (
    alertMinDropPercent != null &&
    prevMin != null &&
    currMin != null &&
    prevMin > 0
  ) {
    const pct = ((prevMin - currMin) / prevMin) * 100;
    if (pct >= alertMinDropPercent) hit = true;
  }
  return hit;
}

function passesCheapNumericAlerts(
  alertMaxRub: number | null,
  alertMinDropRub: number | null,
  alertMinDropPercent: number | null,
  prevPrice: number,
  currPrice: number,
): boolean {
  if (
    alertMaxRub == null &&
    alertMinDropRub == null &&
    alertMinDropPercent == null
  )
    return true;
  if (alertMaxRub != null && currPrice <= alertMaxRub) return true;
  const dr = prevPrice - currPrice;
  if (alertMinDropRub != null && dr >= alertMinDropRub) return true;
  if (
    alertMinDropPercent != null &&
    prevPrice > 0 &&
    (dr / prevPrice) * 100 >= alertMinDropPercent
  )
    return true;
  return false;
}

/** Фильтр для Cheap в режиме «при изменении»: два числовых состояния — как passesCheapNumericAlerts; иначе только max по текущей цене. */
function passesCheapChangeAlerts(
  alertMaxRub: number | null,
  alertMinDropRub: number | null,
  alertMinDropPercent: number | null,
  prior: CheapMonitorState,
  cur: CheapMonitorState,
): boolean {
  if (
    alertMaxRub == null &&
    alertMinDropRub == null &&
    alertMinDropPercent == null
  )
    return true;
  if (prior.k === 'p' && cur.k === 'p') {
    return passesCheapNumericAlerts(
      alertMaxRub,
      alertMinDropRub,
      alertMinDropPercent,
      prior.v,
      cur.v,
    );
  }
  if (cur.k === 'p' && alertMaxRub != null && cur.v <= alertMaxRub)
    return true;
  return false;
}

function passesCheapRtChangeAlerts(
  alertMaxRub: number | null,
  alertMinDropRub: number | null,
  alertMinDropPercent: number | null,
  priorO: CheapMonitorState,
  curO: CheapMonitorState,
  priorR: CheapMonitorState | null,
  curR: CheapMonitorState | null,
): boolean {
  const oOk = passesCheapChangeAlerts(
    alertMaxRub,
    alertMinDropRub,
    alertMinDropPercent,
    priorO,
    curO,
  );
  if (priorR == null || curR == null) return oOk;
  return (
    oOk ||
    passesCheapChangeAlerts(
      alertMaxRub,
      alertMinDropRub,
      alertMinDropPercent,
      priorR,
      curR,
    )
  );
}

function explainCheapRtChange(
  priorO: CheapMonitorState,
  curO: CheapMonitorState,
  priorR: CheapMonitorState | null,
  curR: CheapMonitorState | null,
  fmtRubFn: (n: number) => string,
): string | null {
  const lo = explainCheapChange(priorO, curO, fmtRubFn);
  if (priorR == null || curR == null) return lo;
  const lr = explainCheapChange(priorR, curR, fmtRubFn);
  if (!lo && !lr) return null;
  const parts: string[] = [];
  if (lo) parts.push(`туда · ${lo}`);
  if (lr) parts.push(`обратно · ${lr}`);
  return parts.join('\n');
}

/** Минута от полуночи в Europe/Moscow, 0..1439 */
function minuteOfClockMoscow(d: Date): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Moscow',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(d);
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return hh * 60 + mm;
}

type QuietHourWindow = { startMin: number; endMin: number };

/** Тихое окно: [start,end) если start<end иначе через полночь. start===end считаем выключенным (нет окна длины 0 без off). */
function isInsideQuietMinutes(
  now: Date,
  q: QuietHourWindow | undefined | null,
): boolean {
  if (q == null) return false;
  const { startMin: a, endMin: b } = q;
  if (a === b) return false;
  const c = minuteOfClockMoscow(now);
  if (a < b) return c >= a && c < b;
  return c >= a || c < b;
}

function formatQuietWindowRu(q: QuietHourWindow): string {
  const f = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  return `${f(q.startMin)}–${f(q.endMin)} (МСК)`;
}

function formatFiltersLine(sub: SubState): string {
  const parts: string[] = [];
  if (sub.alertMaxRub != null) parts.push(`≤${sub.alertMaxRub.toLocaleString('ru-RU')} ₽`);
  if (sub.alertMinDropRub != null) parts.push(`↓${sub.alertMinDropRub.toLocaleString('ru-RU')} ₽`);
  if (sub.alertMinDropPercent != null) parts.push(`↓${sub.alertMinDropPercent}%`);
  return parts.length ? parts.join(', ') : 'без фильтра';
}

function mirrorStartPayloadEncodeGroupChatId(id: number): string {
  if (id >= 0) return `u${id}`;
  return `g${String(-id)}`;
}

function decodeMirrorStartPayload(payload: string): number | null {
  const trimmed = payload.trim();
  let m = /^mirror_([gu]\d{1,20})$/i.exec(trimmed);
  if (!m) m = /^([gu]\d{1,20})$/i.exec(trimmed);
  if (!m) return null;
  const tok = m[1].toLowerCase();
  if (tok.startsWith('g')) return -Number(tok.slice(1));
  return Number(tok.slice(1));
}

/** Часы минут МСК: «9», «09:30» → минута суток. */
function parseClockToMinMoscow(s: string): number | null {
  const z = s.trim();
  const full = /^(\d{1,2}):(\d{2})$/.exec(z);
  if (full) {
    const h = Number(full[1]);
    const Mi = Number(full[2]);
    if (
      Number.isFinite(h) &&
      Number.isFinite(Mi) &&
      h >= 0 &&
      h <= 23 &&
      Mi >= 0 &&
      Mi <= 59
    )
      return h * 60 + Mi;
    return null;
  }
  const hOnly = /^(\d{1,2})$/.exec(z);
  if (!hOnly) return null;
  const h = Number(hOnly[1]);
  if (!Number.isFinite(h) || h < 0 || h > 23) return null;
  return h * 60;
}

type SubState = {
  id: number;
  ymd: Ymd;
  originCode: string;
  destCode: string;
  displayO: string;
  displayD: string;
  /** Дата обратного вылета; null — только «туда». */
  returnYmd: Ymd | null;

  lastFetch: number;
  /** Время последней сводки в режиме «раз в час»; 0 = ещё не слали. */
  lastHourlyDigestAt: number;
  /** outbound из Cheap API («туда»). */
  lastResult: CheapestResult | null;
  /** return из Cheap API, если есть дата возврата. */
  lastResultReturn: CheapestResult | null;
  lastVisual: AviasalesVisualSnapshot | null;
  lastApiError: string | null;
  /** Последнее значение ошибки, о которой уже отправили текст (антиспам). */
  lastErrorNotified: string | null;
  /** Базовая строка перевозчиков для сравнения (режим Playwright). */
  priorCarriers: CarrierRubPrice[] | null;
  /** Cheap API «туда». */
  priorCheapState: CheapMonitorState | null;
  /** Cheap API «обратно». */
  priorCheapReturnState: CheapMonitorState | null;
  /** Фильтр «при изменении»: хотя бы одно условие, если что-то задано */
  alertMaxRub: number | null;
  alertMinDropRub: number | null;
  alertMinDropPercent: number | null;
  /** Успешный опрос источника (мс UNIX). */
  lastSuccessfulFetchAt: number;

  timer: NodeJS.Timeout;
};

function subscriptionDirLineTelegram(sub: SubState): string {
  let s = `#${sub.id} ${sub.displayO} → ${sub.displayD}, ${ymdToIso(sub.ymd)}`;
  if (sub.returnYmd != null) s += ` · ⇄ ${ymdToIso(sub.returnYmd)}`;
  return s;
}

function ymdToRuDmY(ymd: Ymd): string {
  return `${pad2(ymd.d)}.${pad2(ymd.m)}.${ymd.y}`;
}

/** Одна строка под «⏰ Сводка по интервалу»: даты из подписки (₽-строки их не знают). */
function subscriptionDigestDatesRu(sub: SubState): string {
  const out = ymdToRuDmY(sub.ymd);
  if (sub.returnYmd == null) return `Дата вылета · ${out}`;
  return `Туда · ${out} · обратно · ${ymdToRuDmY(sub.returnYmd)}`;
}

/** Дата вылета не раньше даты «туда» (календарно). */
function ymdSameOrAfter(a: Ymd, b: Ymd): boolean {
  return ymdSortKey(a) >= ymdSortKey(b);
}

function returnOutboundRelativePreset(outbound: Ymd, label: string): Ymd | null {
  switch (label.trim()) {
    case BTN_RETURN_PLUS_3:
      return calendarAddDays(outbound, 3);
    case BTN_RETURN_PLUS_7:
      return calendarAddDays(outbound, 7);
    case BTN_RETURN_PLUS_14:
      return calendarAddDays(outbound, 14);
    default:
      return null;
  }
}

/** ДД/ММ относительно «якорной» полной даты (выбор календарного года). */
function expandDdMmAnchored(d: number, m: number, anchor: Ymd): Ymd | null {
  for (let yi = -1; yi <= 9; yi++) {
    const y = anchor.y + yi;
    if (!validYmd(y, m, d)) continue;
    const cand: Ymd = { y, m, d };
    if (ymdSortKey(cand) >= ymdSortKey(anchor)) return cand;
  }
  return null;
}

type SubscribeWizardRoute = {
  originRaw: string;
  originCode: string;
  displayO: string;
  destRaw: string;
  destCode: string;
  displayD: string;
};

type SubscribeWizardState =
  | { step: 'await_origin' }
  | {
      step: 'await_dest';
      originRaw: string;
      originCode: string;
      displayO: string;
    }
  | ({ step: 'await_date' } & SubscribeWizardRoute)
  | ({ step: 'await_date_custom' } & SubscribeWizardRoute)
  | ({ step: 'await_trip_mode'; outboundYmd: Ymd } & SubscribeWizardRoute)
  | ({ step: 'await_return_date'; outboundYmd: Ymd } & SubscribeWizardRoute)
  | ({ step: 'await_return_custom'; outboundYmd: Ymd } & SubscribeWizardRoute);

function subscribeWizardKeyboardMarkup(st: SubscribeWizardState) {
  switch (st.step) {
    case 'await_origin':
    case 'await_dest':
      return wizardReplyKeyboard([...POPULAR_CITY_ROWS, [BTN_WIZARD_CANCEL]]);
    case 'await_date':
      return wizardReplyKeyboard([
        ...SUBSCRIBE_DATE_PRESET_ROWS,
        [BTN_WIZARD_CANCEL],
      ]);
    case 'await_date_custom':
      return wizardReplyKeyboard([[BTN_DATE_BACK_PRESETS], [BTN_WIZARD_CANCEL]]);
    case 'await_trip_mode':
      return wizardReplyKeyboard([
        [BTN_TRIP_ONEWAY, BTN_TRIP_ROUND],
        [BTN_WIZARD_CANCEL],
      ]);
    case 'await_return_date':
      return wizardReplyKeyboard([
        [BTN_RETURN_PLUS_3, BTN_RETURN_PLUS_7],
        [BTN_RETURN_PLUS_14, BTN_RETURN_DATE_CUSTOM],
        [BTN_RETURN_BACK_SHAPE],
        [BTN_WIZARD_CANCEL],
      ]);
    case 'await_return_custom':
      return wizardReplyKeyboard([
        [BTN_RETURN_BACK_SHAPE],
        [BTN_WIZARD_CANCEL],
      ]);
  }
}

@Injectable()
export class TelegramService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(TelegramService.name);
  private bot!: Telegraf<Context>;
  private readonly byChat = new Map<number, Map<number, SubState>>();
  private readonly subscribeWizardByChat = new Map<
    number,
    SubscribeWizardState
  >();
  private readonly replyKeyboardSettingsModeByChat = new Set<number>();

  /** Как слать уведомления по всем подпискам чата: при изменении или сводка по интервалу. */
  private readonly notifyPreferenceByChat = new Map<number, NotifyPreference>();
  /** Интервал сводки в мс для режима «Интервал»; без записи — из HOURLY_DIGEST_INTERVAL_MS. */
  private readonly digestIntervalMsByChat = new Map<number, number>();

  /** Скриншот страницы выдачи (Playwright): по умолчанию выкл. */
  private readonly attachScreenshotByChat = new Map<number, boolean>();

  /** Авиасейлс или Купибилет: URL для опроса и кнопки «Билет» (только Playwright). */
  private readonly flightTicketSiteByChat = new Map<number, FlightTicketSite>();

  /** Тихие часы (МСК): храним например 23:00–07:00 как startMin/endMin. Пустая map = нет окна. */
  private readonly quietHoursByChat = new Map<number, QuietHourWindow>();
  /** Группа id → user id: дублировать уведомления в личку (только для id<0). */
  private readonly groupMirrorUserIdByChatId = new Map<number, number>();
  /** Ручная «пробить цены»: не частее MANUAL_CHECK_COOLDOWN_MS на чат. */
  private readonly lastManualCheckAtMsByChat = new Map<number, number>();

  private cachedBotUsername: string | null = null;

  /** Стикеры/анимации (Telegram file_id), опционально из .env. */
  private readonly uxAssets: TelegramUxAssets;

  constructor(
    private readonly config: ConfigService,
    private readonly cities: CitiesService,
    private readonly prices: PricesService,
    private readonly aviasalesShot: AviasalesScreenshotService,
  ) {
    this.uxAssets = loadTelegramUxAssets(this.config);
  }

  private notifyPreferenceFor(chatId: number): NotifyPreference {
    return this.notifyPreferenceByChat.get(chatId) ?? 'on_change';
  }

  /** Прикладывать JPEG выдачи к тексту уведомления (по умолчанию нет). */
  private attachScreenshotFor(chatId: number): boolean {
    return this.attachScreenshotByChat.get(chatId) ?? false;
  }

  private flightListingSiteFor(chatId: number): FlightTicketSite {
    return this.flightTicketSiteByChat.get(chatId) ?? 'aviasales';
  }

  private listingBookingUrl(
    chatId: number,
    originCode: string,
    destCode: string,
    yOut: Ymd,
    yRet: Ymd | null,
  ): string {
    const seg = buildAviasalesListingSegment(
      originCode,
      destCode,
      yOut,
      yRet,
    );
    if (this.priceSource() === 'travelpayouts') {
      return aviasalesUrl(seg);
    }
    return this.flightListingSiteFor(chatId) === 'kupibilet'
      ? buildKupibiletSearchUrl(originCode, destCode, yOut, yRet)
      : aviasalesUrl(seg);
  }

  private listingLinkMarkdownLabel(chatId: number): string {
    return this.flightListingSiteFor(chatId) === 'kupibilet'
      ? 'Купибилет'
      : 'Авиасейлс';
  }
  private replyKb(chatId: number) {
    const rows = this.keyboardRowsFor(chatId);
    return buildReplyKeyboardFromRows(rows);
  }

  /** Клавиатура шага анкеты (только города / дата / отмена, без главного меню). */
  private subscribeWizardKb(
    _chatId: number,
    st: SubscribeWizardState,
  ): ReturnType<typeof wizardReplyKeyboard> {
    void _chatId;
    return subscribeWizardKeyboardMarkup(st);
  }

  private keyboardRowsFor(chatId: number): string[][] {
    if (this.replyKeyboardSettingsModeByChat.has(chatId)) {
      return settingsKeyboardRows(
        this.notifyPreferenceFor(chatId),
        this.attachScreenshotFor(chatId),
        this.flightListingSiteFor(chatId),
      );
    }
    return compactMainKeyboardRows();
  }

  private defaultDigestIntervalMsFromEnv(): number {
    const raw = Number(this.config.get('HOURLY_DIGEST_INTERVAL_MS', 3_600_000));
    if (!Number.isFinite(raw)) return 3_600_000;
    return Math.min(
      MAX_USER_DIGEST_INTERVAL_MS,
      Math.max(MIN_USER_DIGEST_INTERVAL_MS, raw),
    );
  }

  /** Интервал между сводками для чата с учётом лимита и переопределения пользователя. */
  private effectiveDigestIntervalMs(chatId: number): number {
    const explicit = this.digestIntervalMsByChat.get(chatId);
    const base =
      explicit !== undefined
        ? explicit
        : this.defaultDigestIntervalMsFromEnv();
    return Math.min(
      MAX_USER_DIGEST_INTERVAL_MS,
      Math.max(MIN_USER_DIGEST_INTERVAL_MS, base),
    );
  }

  private fmtDigestMsHuman(ms: number): string {
    if (ms >= 3_600_000 && ms % 3_600_000 === 0)
      return `${ms / 3_600_000} ч`;
    if (ms >= 60_000 && ms % 60_000 === 0) return `${ms / 60_000} мин`;
    return `${ms} мс`;
  }

  private async sendDigestPresetPicker(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    await ctx.reply('Интервал сводок:', digestPresetInlineMarkup());
    await ctx.reply('\u2060', this.replyKb(chatId));
  }

  private async applyNotifyPreference(
    ctx: Context,
    next: NotifyPreference,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    this.notifyPreferenceByChat.set(chatId, next);
    const effMs = this.effectiveDigestIntervalMs(chatId);

    if (next === 'on_change') {
      await ctx.reply('Только при изменении цены.', this.replyKb(chatId));
      return;
    }

    await ctx.reply(
      `Периодические сводки · сейчас ≈ каждые ${this.fmtDigestMsHuman(effMs)}. Ниже — быстрый выбор.`,
      this.replyKb(chatId),
    );
    await this.sendDigestPresetPicker(ctx);
  }

  private async applyScreenshotPreference(
    ctx: Context,
    attach: boolean,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    this.attachScreenshotByChat.set(chatId, attach);

    if (this.priceSource() === 'travelpayouts') {
      await ctx.reply(
        attach ? 'Здесь скрин недоступен (другой источник цен).' : 'Ок.',
        this.replyKb(chatId),
      );
      return;
    }

    await ctx.reply(
      attach
        ? 'К уведомлению добавлю скрин страницы выдачи (запрос тяжелее).'
        : 'Только текст выдачи.',
      this.replyKb(chatId),
    );
  }

  private async applyFlightListingSite(
    ctx: Context,
    site: FlightTicketSite,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    if (this.priceSource() === 'travelpayouts') {
      await ctx.reply(
        'Авиасейлс/Купибилет можно выбрать в режиме Playwright (когда PRICE_SOURCE не travelpayouts). Сейчас билеты через Cheap API, ссылка «Билет» всегда ведёт на Авиасейлс.',
        this.replyKb(chatId),
      );
      return;
    }
    this.flightTicketSiteByChat.set(chatId, site);
    const nameRu = site === 'kupibilet' ? 'Купибилет' : 'Авиасейлс';
    await ctx.reply(
      `Страницу для мониторинга и кнопку «Билет» переключаю на ${nameRu}.`,
      this.replyKb(chatId),
    );
  }

  private fmtFetchedAtRuMSK(ts: number): string {
    if (ts <= 0) return 'ещё не было';
    try {
      return new Intl.DateTimeFormat('ru-RU', {
        timeZone: 'Europe/Moscow',
        dateStyle: 'short',
        timeStyle: 'medium',
      }).format(new Date(ts));
    } catch {
      return new Date(ts).toISOString();
    }
  }

  private extractStartPayload(ctx: Context, messageTextFull: string): string {
    const p = ctx as Context & { payload?: string };
    if (typeof p.payload === 'string' && p.payload.trim())
      return p.payload.trim();
    const m = /^\/start(?:@\S+)?\s+(.+)$/i.exec(messageTextFull.trim());
    return m?.[1]?.trim() ?? '';
  }

  private parseRubPositiveInt(tok: string): number | null {
    const digits = tok.replace(/\s/g, '').replace(/\u00A0/g, '');
    if (!/^\d{1,12}$/.test(digits)) return null;
    const n = Number(digits);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  private parsePercent(tok: string): number | null {
    const digits = tok.replace(/\s/g, '').replace(',', '.').replace(/%/g, '');
    const n = Number(digits);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
    return n;
  }

  private async onFilterCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const kb = this.replyKb(chatId);
    const subs = this.subsFor(chatId);
    const text = this.messageText(ctx) ?? '';
    const raw = text.replace(/^\/filter(?:@\w+)?\s*/i, '').trim();
    const toks = raw.split(/\s+/).filter(Boolean);

    if (toks.length === 0) {
      await ctx.reply(
        [
          'Пороги алертов (только в режиме «при изменении цены», не для периодических сводок).',
          '',
          'max — писать только если минимальная цена до N ₽ включительно (не дороже порога).',
          'drop — только если минимум по выдаче упал минимум на N ₽ по сравнению с предыдущей удачной проверкой.',
          'pct — то же падение в процентах: упало минимум на N % от старой цены.',
          '',
          'Можно задать несколько условий: срабатывает любое одно из них (логика ИЛИ). Если ничего не задано — этап как раньше: при любом изменении.',
          '',
          'Команды:',
          '/filter № — показать настройки по подписке',
          '/filter № clear — снять фильтры',
          '/filter № max 45000 drop 800 pct 15 — через пробел задаёшь то, что нужно',
          '',
          'Снять отдельный параметр: max clear, drop clear, pct clear (рядом с номером подписки).',
        ].join('\n'),
        kb,
      );
      return;
    }

    const sid = Number(toks[0]);
    if (!Number.isFinite(sid) || sid <= 0) {
      await ctx.reply('Укажи номер подписки первым числом (из «Мои подписки»).', kb);
      return;
    }

    const sub = subs.get(sid);
    if (!sub) {
      await ctx.reply(`#${sid} в этом чате нет.`, kb);
      return;
    }

    const rest = toks.slice(1);
    if (rest.length === 0) {
      await ctx.reply(
        [
          `#${sid}: ${formatFiltersLine(sub)}`,
          '',
          '≤ … ₽ — max (цена не выше порога)',
          '↓ … ₽ — drop (падение минимум на столько рублей)',
          '↓ … % — pct (падение минимум на столько процентов)',
        ].join('\n'),
        kb,
      );
      return;
    }

    if (/^clear$/i.test(rest[0])) {
      sub.alertMaxRub = sub.alertMinDropRub = sub.alertMinDropPercent = null;
      await ctx.reply(`#${sid}: фильтры сняты · при любом изменении цены будет уведомление.`, kb);
      return;
    }

    let nextMax = sub.alertMaxRub;
    let nextDrop = sub.alertMinDropRub;
    let nextPct = sub.alertMinDropPercent;

    let i = 0;
    while (i < rest.length) {
      const key = rest[i].toLowerCase();
      const valTok = rest[i + 1];
      if (/^(max|до|порог)$/iu.test(key)) {
        if (valTok === undefined || valTok.toLowerCase() === 'clear') {
          nextMax = null;
          i += 2;
          continue;
        }
        const n = this.parseRubPositiveInt(valTok);
        if (n == null) {
          await ctx.reply('После max нужно целое положительное число рублей.', kb);
          return;
        }
        nextMax = n;
        i += 2;
        continue;
      }
      if (/^(drop|руб)$/iu.test(key)) {
        if (valTok === undefined || valTok.toLowerCase() === 'clear') {
          nextDrop = null;
          i += 2;
          continue;
        }
        const n = this.parseRubPositiveInt(valTok);
        if (n == null) {
          await ctx.reply('После drop нужно целое положительное число рублей (падение).', kb);
          return;
        }
        nextDrop = n;
        i += 2;
        continue;
      }
      if (/^(pct|percent|проц)$/iu.test(key)) {
        if (valTok === undefined || valTok.toLowerCase() === 'clear') {
          nextPct = null;
          i += 2;
          continue;
        }
        const n = this.parsePercent(valTok);
        if (n == null) {
          await ctx.reply('После pct число процентов 1–100.', kb);
          return;
        }
        nextPct = n;
        i += 2;
        continue;
      }

      await ctx.reply(
        'Не понял токен. Пример: /filter ' +
          `${sid} max 42000 drop 500 pct 5`,
        kb,
      );
      return;
    }

    sub.alertMaxRub = nextMax;
    sub.alertMinDropRub = nextDrop;
    sub.alertMinDropPercent = nextPct;

    await ctx.reply(`#${sid}: сохранено · ${formatFiltersLine(sub)}`, kb);
  }

  private async onQuietCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const kb = this.replyKb(chatId);
    const text = this.messageText(ctx) ?? '';
    const raw = text.replace(/^\/quiet(?:@\w+)?\s*/i, '').trim();

    if (!raw || /^help$|\?$/iu.test(raw)) {
      await ctx.reply(
        [
          'Тишина в МСК (уведомления не шлю):',
          '/quiet HH HH — например `/quiet 23 7` (с 23:00 до 07:00 следующего дня)',
          '/quiet 22:45 06:30',
          '/quiet off',
        ].join('\n'),
        kb,
      );
      return;
    }

    const quietFirst =
      raw.split(/\s+/)[0]?.toLocaleLowerCase('ru-RU') ?? '';

    if (/^(off|нет|выкл)$/iu.test(quietFirst)) {
      this.quietHoursByChat.delete(chatId);
      await ctx.reply('Тихие часы выключены для этого чата.', kb);
      return;
    }

    const parts = raw.split(/\s+/);
    if (parts.length !== 2) {
      await ctx.reply('Нужно два значения времени или off.', kb);
      return;
    }

    const a = parseClockToMinMoscow(parts[0]);
    const b = parseClockToMinMoscow(parts[1]);
    if (a == null || b == null) {
      await ctx.reply(
        'Время например `23`, `07` или `22:45` · оба часа по Москве.',
        kb,
      );
      return;
    }

    if (a === b) {
      await ctx.reply('Границы совпали — включи хотя бы минутный зазор.', kb);
      return;
    }

    const win = { startMin: a, endMin: b } satisfies QuietHourWindow;
    this.quietHoursByChat.set(chatId, win);
    await ctx.reply(`Тишина МСК: ${formatQuietWindowRu(win)}`, kb);
  }

  private async onMirrorCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const kb = this.replyKb(chatId);
    const uid = ctx.from?.id;
    const text = this.messageText(ctx) ?? '';
    const raw = text.replace(/^\/mirror(?:@\w+)?\s*/i, '').trim();

    const mwFirst =
      raw.split(/\s+/)[0]?.toLocaleLowerCase('ru-RU') ?? '';

    if (/^(off|выкл|нет)$/iu.test(mwFirst)) {
      if (this.isGroupChatId(chatId)) {
        this.groupMirrorUserIdByChatId.delete(chatId);
        await ctx.reply('Дублирование в личку для этой группы выключено.', kb);
        return;
      }
      if (uid == null) return;
      let removed = 0;
      for (const [g, u] of [...this.groupMirrorUserIdByChatId.entries()]) {
        if (u === uid) {
          this.groupMirrorUserIdByChatId.delete(g);
          removed++;
        }
      }
      await ctx.reply(
        removed
          ? `Снято связей: ${removed}.`
          : 'Нет активных связей «группа → личка» на твой аккаунт.',
        kb,
      );
      return;
    }

    if (!this.isGroupChatId(chatId)) {
      await ctx.reply(
        'Ссылку на дублирование выдаёт только группа. В личке можно снять всё: /mirror off',
        kb,
      );
      return;
    }

    const un = await this.ensureBotUsername();
    if (!un) {
      await ctx.reply(
        'Пока не знаю юзернейм бота — повторите позже после getMe.',
        kb,
      );
      return;
    }

    const enc = mirrorStartPayloadEncodeGroupChatId(chatId);
    const url = `https://t.me/${un}?start=mirror_${enc}`;
    await ctx.reply(
      [
        'Чтобы получать те же сообщения без кнопок «Билет»/«Отписаться»:',
        '',
        url,
        '',
        'Открыть нужно тем Telegram-аккаунтом, которому всё должно лететь.',
        'Выключить: в группе `/mirror off` или в ЛС `/mirror off` (снимет все связи на тебя).',
      ].join('\n'),
      kb,
    );
  }

  private async onStatusCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const kb = this.replyKb(chatId);
    const subs = this.subsFor(chatId);
    const n = subs.size;

    let lastOk = 0;
    for (const s of subs.values())
      lastOk = Math.max(lastOk, s.lastSuccessfulFetchAt);

    const pref =
      this.notifyPreferenceFor(chatId) === 'on_change'
        ? 'при изменении цены'
        : `сводка каждые ≈ ${this.fmtDigestMsHuman(this.effectiveDigestIntervalMs(chatId))}`;

    const shot =
      this.priceSource() === 'travelpayouts'
        ? 'Cheap API · ссылка «Билет» только Авиасейлс'
        : `${this.attachScreenshotFor(chatId) ? 'со скрином выдачи' : 'только текст'}, страница — ${this.flightListingSiteFor(chatId) === 'kupibilet' ? 'Купибилет' : 'Авиасейлс'}`;

    const q = this.quietHoursByChat.get(chatId);
    const quietLine = q != null ? formatQuietWindowRu(q) : 'нет';

    let mirrorLine = 'нет';
    if (this.isGroupChatId(chatId)) {
      const u = this.groupMirrorUserIdByChatId.get(chatId);
      mirrorLine =
        u != null ? `да → user ${u}` : 'нет · /mirror если нужна копия в ЛС';
    } else {
      const uid = ctx.from?.id;
      let nBind = 0;
      if (uid != null) {
        for (const [, v] of this.groupMirrorUserIdByChatId)
          if (v === uid) nBind++;
      }
      mirrorLine =
        nBind > 0
          ? `на тебя связано групп: ${nBind}`
          : 'нет (открой ссылку из группы)';
    }

    const lines = [
      `Подписок: ${n}`,
      `Режим: ${pref}`,
      `Выдача: ${shot}`,
      `Тихие часы (МСК): ${quietLine}`,
      `Дубль в ЛС с группы: ${mirrorLine}`,
      `Последний удачный опрос источника: ${this.fmtFetchedAtRuMSK(lastOk)}`,
    ];

    await ctx.reply(lines.join('\n'), kb);
  }

  private async onReplySettingsButton(ctx: Context): Promise<void> {
    const raw = this.messageText(ctx)?.trim();
    if (!raw) return;

    const t = stripLeadingSuccessEmoji(raw);

    if (t === BTN_NOTIFY_ON_CHANGE) {
      await this.applyNotifyPreference(ctx, 'on_change');
      return;
    }
    if (t === BTN_NOTIFY_HOURLY || t === LEGACY_BTN_NOTIFY_HOURLY) {
      await this.applyNotifyPreference(ctx, 'hourly');
      return;
    }
    if (t === BTN_SHOT_TEXT) {
      await this.applyScreenshotPreference(ctx, false);
      return;
    }
    if (t === BTN_SHOT_SCREEN) {
      await this.applyScreenshotPreference(ctx, true);
      return;
    }
    if (t === BTN_FLIGHT_SITE_AVIASALES) {
      await this.applyFlightListingSite(ctx, 'aviasales');
      return;
    }
    if (t === BTN_FLIGHT_SITE_KUPIBILET) {
      await this.applyFlightListingSite(ctx, 'kupibilet');
      return;
    }
  }

  private async onDigestPreset(ctx: Context): Promise<void> {
    const cq = ctx.callbackQuery;
    if (
      cq == null ||
      !('data' in cq) ||
      cq.data == null ||
      ctx.chat?.id == null
    ) {
      await ctx.answerCbQuery();
      return;
    }
    const m = /^d:(\d+)$/.exec(cq.data);
    if (m === null) {
      await ctx.answerCbQuery();
      return;
    }
    const rawMs = Number(m[1]);
    if (!DIGEST_PRESET_CALLBACK_MS.has(rawMs)) {
      await ctx.answerCbQuery('Недоступный пресет');
      return;
    }
    const chatId = ctx.chat.id;
    const clamped = Math.min(
      MAX_USER_DIGEST_INTERVAL_MS,
      Math.max(MIN_USER_DIGEST_INTERVAL_MS, rawMs),
    );
    this.digestIntervalMsByChat.set(chatId, clamped);

    await ctx.answerCbQuery(this.fmtDigestMsHuman(clamped));

    await ctx.reply(`Ок · ${this.fmtDigestMsHuman(clamped)}`, this.replyKb(chatId));
  }

  private async onDigestMsCommand(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const text = this.messageText(ctx) ?? '';
    const rest = text.replace(/^\/digest_ms(@\w+)?\s*/i, '').trim();

    if (!rest) {
      const ms = this.effectiveDigestIntervalMs(chatId);
      const overridden = this.digestIntervalMsByChat.has(chatId);
      await ctx.reply(
        `Сводки ≈ каждые ${this.fmtDigestMsHuman(ms)}` +
          (overridden ? ' · свой шаг' : ''),
        this.replyKb(chatId),
      );
      await this.sendDigestPresetPicker(ctx);
      return;
    }

    if (/^default$/i.test(rest) || /^сброс$/iu.test(rest)) {
      this.digestIntervalMsByChat.delete(chatId);
      const ms = this.effectiveDigestIntervalMs(chatId);
      await ctx.reply(`Сброшено · ${this.fmtDigestMsHuman(ms)}`, this.replyKb(chatId));
      return;
    }

    if (!/^\d{1,14}$/.test(rest)) {
      await ctx.reply('Нужно целое число миллисекунд или default.', this.replyKb(chatId));
      return;
    }

    const n = Number(rest);
    if (!Number.isSafeInteger(n) || n <= 0) {
      await ctx.reply('Некорректное число.', this.replyKb(chatId));
      return;
    }
    const clamped = Math.min(
      MAX_USER_DIGEST_INTERVAL_MS,
      Math.max(MIN_USER_DIGEST_INTERVAL_MS, n),
    );
    this.digestIntervalMsByChat.set(chatId, clamped);
    const note = clamped !== n ? ` (диапазон ${MIN_USER_DIGEST_INTERVAL_MS}…${MAX_USER_DIGEST_INTERVAL_MS} мс)` : '';

    await ctx.reply(`Ок · ${this.fmtDigestMsHuman(clamped)}${note}`, this.replyKb(chatId));
  }

  private cheapResultDigestCaption(result: CheapestResult): string {
    return formatCheapApiOfferRu(result, (n) => this.fmtRub(n));
  }

  private priceSource(): 'aviasales_screenshot' | 'travelpayouts' {
    const s = (
      this.config.get<string>('PRICE_SOURCE') ?? 'aviasales_screenshot'
    ).toLowerCase();
    return s === 'travelpayouts' ? 'travelpayouts' : 'aviasales_screenshot';
  }

  private isGroupChatId(id: number): boolean {
    return id < 0;
  }

  private async ensureBotUsername(): Promise<string | null> {
    if (this.cachedBotUsername !== null) return this.cachedBotUsername;
    try {
      const me = await this.bot.telegram.getMe();
      this.cachedBotUsername = me.username ?? null;
    } catch {
      this.cachedBotUsername = null;
    }
    return this.cachedBotUsername;
  }

  private isQuietHours(chatId: number, when: Date): boolean {
    const w = this.quietHoursByChat.get(chatId);
    return isInsideQuietMinutes(when, w);
  }

  /** Дублировать в ЛС без inline-кнопок (callback в ЛС не совпадёт с группой). */
  private async mirrorPlainIfGroup(
    originChatId: number,
    plain: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isGroupChatId(originChatId)) return;
    const uid = this.groupMirrorUserIdByChatId.get(originChatId);
    if (uid == null || uid === originChatId) return;
    try {
      await this.bot.telegram.sendMessage(uid, plain, {
        link_preview_options: { is_disabled: true },
        ...(extra ?? {}),
      });
    } catch (e) {
      this.log.warn(`mirror ${uid}: ${String(e)}`);
    }
  }

  private async mirrorMarkdownIfGroup(
    originChatId: number,
    markdown: string,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    if (!this.isGroupChatId(originChatId)) return;
    const uid = this.groupMirrorUserIdByChatId.get(originChatId);
    if (uid == null || uid === originChatId) return;
    try {
      await this.bot.telegram.sendMessage(uid, markdown, {
        parse_mode: 'Markdown',
        link_preview_options: { is_disabled: true },
        ...(extra ?? {}),
      });
    } catch (e) {
      this.log.warn(`mirror md ${uid}: ${String(e)}`);
    }
  }

  private async mirrorPhotoIfGroup(
    originChatId: number,
    photo: Buffer,
    captionMd: string,
  ): Promise<void> {
    if (!this.isGroupChatId(originChatId)) return;
    const uid = this.groupMirrorUserIdByChatId.get(originChatId);
    if (uid == null || uid === originChatId) return;
    const cap =
      captionMd.length > 1024 ? captionMd.slice(0, 1018) + ' …' : captionMd;
    try {
      await this.bot.telegram.sendPhoto(
        uid,
        { source: photo, filename: 'copy.jpg' },
        {
          caption: cap,
          parse_mode: 'Markdown',
        },
      );
    } catch (e) {
      this.log.warn(`mirror photo ${uid}: ${String(e)}`);
    }
  }

  /** То же решение по фото, что у sendAviasalesMarkdownPhoto, но только для дубля в ЛС (без кнопок). */
  private mirrorAviasalesDigestIfGroup(
    originChatId: number,
    markdown: string,
    photo: Buffer | undefined,
    attachPhoto: boolean,
  ): void {
    const usePic =
      attachPhoto &&
      photo !== undefined &&
      Buffer.isBuffer(photo) &&
      photo.length >= 2048;
    if (usePic) {
      void this.mirrorPhotoIfGroup(originChatId, photo, markdown);
    } else {
      void this.mirrorMarkdownIfGroup(originChatId, markdown);
    }
  }

  private flightDigestCardOverlayEnabled(): boolean {
    const v = (
      this.config.get<string>('FLIGHT_DIGEST_CARD_OVERLAY') ?? 'true'
    )
      .toLowerCase()
      .trim();
    return v !== 'false' && v !== '0' && v !== 'off';
  }

  /** Данные для графической карточки (без Markdown). */
  private buildHourlyDigestCardPayload(
    sub: SubState,
    carrierLinesPlain: string[],
  ): FlightDigestCardInput {
    return {
      routeTitle: `#${sub.id} · ${sub.displayO} → ${sub.displayD}`,
      datesLine: subscriptionDigestDatesRu(sub),
      lines:
        carrierLinesPlain.length > 0
          ? carrierLinesPlain
          : ['В тексте страницы не найдены суммы в ₽'],
    };
  }

  private async applyFlightDigestOverlay(
    jpeg: Buffer | undefined,
    card: FlightDigestCardInput | null,
  ): Promise<Buffer | undefined> {
    if (
      !jpeg?.length ||
      jpeg.length < 2048 ||
      !card ||
      !this.flightDigestCardOverlayEnabled()
    ) {
      return jpeg;
    }
    try {
      return await compositeFlightDigestOnScreenshot(jpeg, card);
    } catch (e) {
      this.log.warn(`FLIGHT_DIGEST_CARD_OVERLAY: ${String(e)}`);
      return jpeg;
    }
  }

  private async deleteMessageBestEffort(
    chatId: number,
    messageId: number,
    logFailures = false,
  ): Promise<void> {
    try {
      await this.bot.telegram.deleteMessage(chatId, messageId);
    } catch (e) {
      if (logFailures) {
        this.log.warn(
          `Telegram deleteMessage chat=${chatId} msg=${messageId}: ${telegramErrorDescription(e)}`,
        );
      }
    }
  }

  private async sendStickerBestEffort(
    chatId: number,
    fileId?: string,
  ): Promise<number | null> {
    const raw = fileId?.trim();
    if (!raw) return null;
    try {
      let m:
        | { message_id: number }
        | undefined;
      if (/^https?:\/\//i.test(raw)) {
        const res = await fetch(raw, {
          redirect: 'follow',
          signal: AbortSignal.timeout(25_000),
        });
        if (!res.ok) {
          this.log.warn(`Telegram sendSticker: загрузка URL → HTTP ${res.status}`);
          return null;
        }
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 48 || buf.length > 6_000_000) {
          this.log.warn(
            'Telegram sendSticker: неверный размер файла по URL (ожидайте маленький .webp набора Telegram)',
          );
          return null;
        }
        m = await this.bot.telegram.sendSticker(chatId, { source: buf });
      } else {
        m = await this.bot.telegram.sendSticker(chatId, raw);
      }
      return m?.message_id ?? null;
    } catch (e) {
      this.log.warn(`Telegram sendSticker: ${telegramErrorDescription(e)}`);
      return null;
    }
  }

  private async sendAnimationBestEffort(
    chatId: number,
    fileIdOrUrl?: string,
  ): Promise<number | null> {
    const s = fileIdOrUrl?.trim();
    if (!s) return null;
    try {
      const m = await this.bot.telegram.sendAnimation(chatId, s);
      return m.message_id;
    } catch (e) {
      this.log.warn(`Telegram sendAnimation: ${telegramErrorDescription(e)}`);
      return null;
    }
  }

  /** Стикер пропадает сам — аккуратное «эмоциональное» украшение без мусора. */
  private flashTransientStickerLater(
    chatId: number,
    fileId: string | undefined,
    holdMs = 4000,
  ): void {
    if (!fileId) return;
    void (async () => {
      const mid = await this.sendStickerBestEffort(chatId, fileId);
      if (mid == null) return;
      await new Promise<void>((r) => setTimeout(r, holdMs));
      await this.deleteMessageBestEffort(chatId, mid, true);
    })();
  }

  /** В личке delete обычно ок; в группе нужны права «Удалять сообщения». */
  private logUxDecorationHintOnce(): void {
    let any = false;
    const u = this.uxAssets;
    if (
      u.stickerChecking ||
      u.stickerCooldown ||
      u.stickerSuccess ||
      u.animationLoading
    ) {
      any = true;
    }
    if (!any) {
      this.log.log(
        'Telegram UX: не заданы TELEGRAM_STICKER_* / TELEGRAM_ANIMATION_LOADING — без стикеров и загрузочной gif (см. .env.example).',
      );
      return;
    }
    this.log.log(
      'Telegram UX: стикеры/анимации включены; file_id только от этого же бота. В группе для удаления «лишних» сообщений нужны права администратора с «Удаление сообщений».',
    );
  }

  onModuleInit(): void {
    const token = this.config.getOrThrow<string>('TELEGRAM_BOT_TOKEN');
    this.bot = new Telegraf(token);

    this.bot.use(async (ctx, next) => {
      const text = this.messageText(ctx);
      const chatId = ctx.chat?.id;
      if (chatId != null && text != null && text.length && !text.startsWith('/')) {
        if (this.subscribeWizardByChat.has(chatId)) {
          if (isReplyMainKeyboardText(text)) {
            this.subscribeWizardByChat.delete(chatId);
            return next();
          }
          await this.onSubscribeWizardText(ctx);
          return;
        }
      }
      return next();
    });

    this.bot.start((ctx) => void this.onStart(ctx));
    this.bot.help((ctx) => void this.onHelp(ctx));
    this.bot.command('subscribe', (ctx) => void this.onSubscribe(ctx));
    this.bot.command('cancel', (ctx) => void this.onCancelWizard(ctx));
    this.bot.command('unsubscribe', (ctx) => void this.onUnsubscribe(ctx));
    this.bot.command('mysubs', (ctx) => void this.onList(ctx));
    this.bot.command('list', (ctx) => void this.onList(ctx));
    this.bot.command('digest_ms', (ctx) => void this.onDigestMsCommand(ctx));
    this.bot.command('filter', (ctx) => void this.onFilterCommand(ctx));
    this.bot.command('quiet', (ctx) => void this.onQuietCommand(ctx));
    this.bot.command('mirror', (ctx) => void this.onMirrorCommand(ctx));
    this.bot.command('status', (ctx) => void this.onStatusCommand(ctx));
    this.bot.hears(['🛫 Как подписаться', 'Как подписаться'], (ctx) =>
      void this.onHowToSubscribeTap(ctx),
    );
    this.bot.hears(['📍 Подписаться', 'Подписаться'], (ctx) =>
      void this.onSubscribeShortcut(ctx),
    );
    this.bot.hears(['📋 Мои подписки', 'Мои подписки'], (ctx) =>
      void this.onList(ctx),
    );
    this.bot.hears([BTN_MANUAL_CHECK, 'Пора проверить'], (ctx) =>
      void this.onManualCheckSubscriptions(ctx),
    );
    this.bot.hears(['🔕 Снять все подписки', 'Снять все подписки'], (ctx) =>
      void this.onUnsubscribeAllViaButton(ctx),
    );
    this.bot.hears([BTN_SETTINGS], (ctx) =>
      void this.onOpenSettingsKeyboard(ctx),
    );
    this.bot.hears([BTN_MAIN_MENU], (ctx) =>
      void this.onCloseSettingsKeyboard(ctx),
    );
    this.bot.hears(
      (text) => {
        if (text == null || text.length === 0 || text.startsWith('/'))
          return null;
        const b = stripLeadingSuccessEmoji(text);
        if (
          b === BTN_NOTIFY_ON_CHANGE ||
          b === BTN_NOTIFY_HOURLY ||
          b === LEGACY_BTN_NOTIFY_HOURLY ||
          b === BTN_SHOT_TEXT ||
          b === BTN_SHOT_SCREEN ||
          b === BTN_FLIGHT_SITE_AVIASALES ||
          b === BTN_FLIGHT_SITE_KUPIBILET
        ) {
          return dummyHearMatchResult;
        }
        return null;
      },
      (ctx) => void this.onReplySettingsButton(ctx),
    );
    this.bot.action(/^d:(\d+)$/, (ctx) => void this.onDigestPreset(ctx));
    this.bot.action(CB_SUBSCRIBE_WIZARD, (ctx) =>
      void this.onInlineSubscribeWizard(ctx),
    );
    this.bot.action(/^u:(\d+)$/, (ctx) => void this.onInlineUnsubscribe(ctx));
    void this.bot.launch().then(() => {
      this.logUxDecorationHintOnce();
      this.log.log('Бот запущен (long polling)');
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.subscribeWizardByChat.clear();
    this.replyKeyboardSettingsModeByChat.clear();
    this.notifyPreferenceByChat.clear();
    this.digestIntervalMsByChat.clear();
    this.attachScreenshotByChat.clear();
    this.flightTicketSiteByChat.clear();
    this.quietHoursByChat.clear();
    this.groupMirrorUserIdByChatId.clear();
    this.lastManualCheckAtMsByChat.clear();
    for (const subs of this.byChat.values()) {
      for (const s of subs.values()) clearInterval(s.timer);
    }
    this.byChat.clear();
    this.bot?.stop('SIGTERM');
  }

  private async onStart(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    this.replyKeyboardSettingsModeByChat.delete(chatId);

    const fullLine = this.messageText(ctx) ?? '';
    const pl = this.extractStartPayload(ctx, fullLine);
    const maybeGroupId = decodeMirrorStartPayload(pl);
    const uidStart = ctx.from?.id;

    if (
      maybeGroupId != null &&
      maybeGroupId < 0 &&
      ctx.chat?.type === 'private' &&
      uidStart != null
    ) {
      this.groupMirrorUserIdByChatId.set(maybeGroupId, uidStart);
      await ctx.reply(
        [
          'Готово.',
          '',
          `Сюда будут дублироваться текстовые уведомления из группы ${maybeGroupId} (без кнопок).`,
          'Снять все связки на свой аккаунт: /mirror off',
          'Или попросите в группе: /mirror off',
        ].join('\n'),
        this.replyKb(ctx.chat!.id),
      );
      return;
    }

    await ctx.reply(
      [
        'Привет 👋',
        '',
        '✈️ Здесь можно добавить билет на рейс — бот будет следить за ценой.',
        '',
        'Нужны три вещи: город отправления, город прибытия и дата.',
        '',
        '📍 Начни с кнопки «Подписаться» снизу или открой «Как подписаться» для подсказки.',
        'Или отправь команду: /subscribe и с пробелом ссылку вида https://www.aviasales.ru/search/… или https://www.kupibilet.ru/search?… — распознаю маршрут.',
        '',
        'Режим уведомлений и вид карточки — в «⚙️ Настройки».',
      ].join('\n'),
      this.replyKb(ctx.chat!.id),
    );
  }

  private async onHelp(ctx: Context): Promise<void> {
    await ctx.reply(
      [
        '✈️ Кнопки снизу: «Подписаться», «Мои подписки», 🔄 «Пора проверить», «⚙️ Настройки».',
        '«Пора проверить» — свежие цены по всем подпискам чата разом (не чаще чем раз в 3 мин).',
        'Снять все подписки — «Настройки» · строка 🔕 ниже параметров.',
        '',
        'Команды: /filter · /quiet · по желанию /mirror (группы), /status.',
      ].join('\n'),
      this.replyKb(ctx.chat!.id),
    );
  }

  private async onHowToSubscribeTap(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    await ctx.reply(
      [
        '✈️ Чтобы оформить подписку на билеты, укажи:',
        '',
        '• город отправления',
        '• город прибытия',
        '• дату вылета',
        '',
        'После выбора даты бот спросит: только туда или туда‑обратно; если «обратно» — укажешь дату возврата (одна подписка на связку).',
        '',
        'Нажми кнопку ниже 👇 — откроется пошаговое добавление.',
        '',
        'На первом шаге можно вставить ссылку поиска:',
        '',
        '• из Авиасейлс, например https://www.aviasales.ru/search/LED1505SVX1',
        '• туда‑обратно из Авиасейлс одним сегментом, например LED1505SVX18051',
        '• или из Kupibilet — один route[0], либо два сегмента route[0]+route[1] туда‑обратно',
        '',
        'Или /subscribe и та же ссылка — подтянется маршрут; в Авиасейлс в ссылке даты «туда» и «обратно» задаются ДДММ (для туда‑обратно — второй ДДММ после кода города прилёта).',
        '',
        'Или одной строкой: Москва Екатеринбург 2026-06-15 · Москва | Сочи | 2028-05-12 · LED SVX 12.05.2028',
      ].join('\n'),
      subscribeHowtoInlineMarkup(),
    );
    await ctx.reply('\u2060', this.replyKb(chatId));
  }

  private async onOpenSettingsKeyboard(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    this.replyKeyboardSettingsModeByChat.add(chatId);
    await ctx.reply(
      'Параметры ниже · «Главное меню» — назад. Снять все подписки — самая нижняя строка.',
      this.replyKb(chatId),
    );
  }

  private async onCloseSettingsKeyboard(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    this.replyKeyboardSettingsModeByChat.delete(chatId);
    await ctx.reply('Снова главное меню.', this.replyKb(chatId));
  }

  private async onSubscribe(ctx: Context): Promise<void> {
    const text = this.messageText(ctx);
    if (!text) {
      await ctx.reply(
        '📍 Напиши /subscribe текстом назначения или используй нижнюю кнопку «Подписаться».',
        this.replyKb(ctx.chat!.id),
      );
      return;
    }
    const rest = text.replace(/^\/subscribe(@\w+)?\s*/i, '').trim();

    if (!rest) {
      await this.beginSubscribeWizard(ctx);
      return;
    }

    this.subscribeWizardByChat.delete(ctx.chat!.id);
    const parsed = await this.parseSubscribePayload(rest);
    if ('error' in parsed) {
      await ctx.reply(parsed.error, this.replyKb(ctx.chat!.id));
      return;
    }
    await this.activateSubscription(ctx, parsed);
  }

  private async onSubscribeShortcut(ctx: Context): Promise<void> {
    await this.beginSubscribeWizard(ctx);
  }

  private async onInlineSubscribeWizard(ctx: Context): Promise<void> {
    await ctx.answerCbQuery('Открываю шаги');
    await this.beginSubscribeWizard(ctx);
  }

  private async onCancelWizard(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;

    if (this.subscribeWizardByChat.delete(chatId)) {
      await ctx.reply('Отменил.', this.replyKb(ctx.chat!.id));
    } else {
      await ctx.reply('Сейчас подписка не оформляется.', this.replyKb(ctx.chat!.id));
    }
  }

  private async beginSubscribeWizard(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const wizardState: SubscribeWizardState = { step: 'await_origin' };
    this.subscribeWizardByChat.set(chatId, wizardState);
    await ctx.reply(
        '🛫 Откуда вылетаете: напишите город или вставьте ссылку поиска (aviasales.ru/search/… или kupibilet.ru/search?… с route[0]=…)',
      this.subscribeWizardKb(chatId, wizardState),
    );
  }

  private async finishSubscribeWizard(
    ctx: Context,
    r: SubscribeWizardRoute,
    outboundYmd: Ymd,
    returnYmd: Ymd | null,
  ): Promise<void> {
    const chatId = ctx.chat!.id;
    this.subscribeWizardByChat.delete(chatId);
    await this.activateSubscription(ctx, {
      originCode: r.originCode,
      destCode: r.destCode,
      displayO: r.displayO,
      displayD: r.displayD,
      ymd: outboundYmd,
      returnYmd,
    });
  }

  private async onSubscribeWizardText(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const st = this.subscribeWizardByChat.get(chatId);
    if (!st) return;

    const line = this.messageText(ctx)?.trim();
    if (!line) return;

    if (line === BTN_WIZARD_CANCEL) {
      this.subscribeWizardByChat.delete(chatId);
      await ctx.reply('Ок.', this.replyKb(chatId));
      return;
    }

    switch (st.step) {
      case 'await_origin': {
        const fromKup = await this.tryImportKupibilet(line);
        if (fromKup !== null) {
          if ('error' in fromKup) {
            await ctx.reply(fromKup.error, this.subscribeWizardKb(chatId, st));
            return;
          }
          this.subscribeWizardByChat.delete(chatId);
          await this.activateSubscription(ctx, fromKup);
          return;
        }

        const fromLink = await this.tryImportAviasales(line);
        if (fromLink !== null) {
          if ('error' in fromLink) {
            await ctx.reply(fromLink.error, this.subscribeWizardKb(chatId, st));
            return;
          }
          this.subscribeWizardByChat.delete(chatId);
          await this.activateSubscription(ctx, fromLink);
          return;
        }

        const o = await this.cities.resolveCity(line);
        if (!o) {
          await ctx.reply(
            `Не нашёл «${line}». Другой вариант или IATA.`,
            this.subscribeWizardKb(chatId, st),
          );
          return;
        }
        const nextSt: SubscribeWizardState = {
          step: 'await_dest',
          originRaw: line,
          originCode: o.code,
          displayO: o.name,
        };
        this.subscribeWizardByChat.set(chatId, nextSt);
        await ctx.reply(`Вылет: ${o.name}. Куда летим?`, this.subscribeWizardKb(chatId, nextSt));
        break;
      }
      case 'await_dest': {
        const d = await this.cities.resolveCity(line);
        if (!d) {
          await ctx.reply(`Города «${line}» нет. Попробуй ещё раз.`, this.subscribeWizardKb(chatId, st));
          return;
        }
        if (d.code === st.originCode) {
          await ctx.reply('Нужен другой город прилёта.', this.subscribeWizardKb(chatId, st));
          return;
        }
        const nextSt: SubscribeWizardState = {
          step: 'await_date',
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: line,
          destCode: d.code,
          displayD: d.name,
        };
        this.subscribeWizardByChat.set(chatId, nextSt);
        await ctx.reply(
          `${nextSt.displayO} → ${nextSt.displayD}. Дата рейса — пресеты или свой ввод.`,
          this.subscribeWizardKb(chatId, nextSt),
        );
        break;
      }
      case 'await_date': {
        const byPreset = subscribeDatePresetFromLabel(line);
        if (byPreset) {
          const nextSt: SubscribeWizardState = {
            step: 'await_trip_mode',
            outboundYmd: byPreset,
            originRaw: st.originRaw,
            originCode: st.originCode,
            displayO: st.displayO,
            destRaw: st.destRaw,
            destCode: st.destCode,
            displayD: st.displayD,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            `Туда · ${ymdToIso(byPreset)}.\nНужен обратный билет в этой же подписке?`,
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        if (line === BTN_DATE_CUSTOM) {
          const nextSt: SubscribeWizardState = {
            step: 'await_date_custom',
            originRaw: st.originRaw,
            originCode: st.originCode,
            displayO: st.displayO,
            destRaw: st.destRaw,
            destCode: st.destCode,
            displayD: st.displayD,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            'Формат: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД',
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        const typed = parseDateToken(line);
        if (!typed) {
          await ctx.reply(
            'Выбери кнопку или введи дату в указанном формате.',
            this.subscribeWizardKb(chatId, st),
          );
          return;
        }
        const nextStAfterDate: SubscribeWizardState = {
          step: 'await_trip_mode',
          outboundYmd: typed,
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: st.destRaw,
          destCode: st.destCode,
          displayD: st.displayD,
        };
        this.subscribeWizardByChat.set(chatId, nextStAfterDate);
        await ctx.reply(
          `Туда · ${ymdToIso(typed)}.\nНужен обратный билет в этой же подписке?`,
          this.subscribeWizardKb(chatId, nextStAfterDate),
        );
        break;
      }
      case 'await_date_custom': {
        if (line === BTN_DATE_BACK_PRESETS) {
          const nextSt: SubscribeWizardState = {
            step: 'await_date',
            originRaw: st.originRaw,
            originCode: st.originCode,
            displayO: st.displayO,
            destRaw: st.destRaw,
            destCode: st.destCode,
            displayD: st.displayD,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            `${nextSt.displayO} → ${nextSt.displayD} — выбери дату`,
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        const typed = parseDateToken(line);
        if (!typed) {
          await ctx.reply('Например: 15.06.2026', this.subscribeWizardKb(chatId, st));
          return;
        }
        const nextStCust: SubscribeWizardState = {
          step: 'await_trip_mode',
          outboundYmd: typed,
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: st.destRaw,
          destCode: st.destCode,
          displayD: st.displayD,
        };
        this.subscribeWizardByChat.set(chatId, nextStCust);
        await ctx.reply(
          `Туда · ${ymdToIso(typed)}.\nНужен обратный билет в этой же подписке?`,
          this.subscribeWizardKb(chatId, nextStCust),
        );
        break;
      }
      case 'await_trip_mode': {
        const route: SubscribeWizardRoute = {
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: st.destRaw,
          destCode: st.destCode,
          displayD: st.displayD,
        };
        const tp = stripLeadingSuccessEmoji(line);
        if (tp === BTN_TRIP_ONEWAY) {
          await this.finishSubscribeWizard(ctx, route, st.outboundYmd, null);
          return;
        }
        if (tp === BTN_TRIP_ROUND) {
          const nextSt: SubscribeWizardState = {
            step: 'await_return_date',
            outboundYmd: st.outboundYmd,
            ...route,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            `Туда уже ${ymdToIso(st.outboundYmd)}.\nВыбери дату обратного вылета (${st.displayD} → ${st.displayO}) или свой ввод.`,
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        await ctx.reply(
          'Нажми «Только туда» или «Туда‑обратно», либо «Отмена».',
          this.subscribeWizardKb(chatId, st),
        );
        break;
      }
      case 'await_return_date': {
        const route: SubscribeWizardRoute = {
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: st.destRaw,
          destCode: st.destCode,
          displayD: st.displayD,
        };
        if (line === BTN_RETURN_BACK_SHAPE) {
          const nextSt: SubscribeWizardState = {
            step: 'await_date',
            ...route,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            `${nextSt.displayO} → ${nextSt.displayD} — заново выбери дату вылета «туда».`,
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        const presetRet = returnOutboundRelativePreset(st.outboundYmd, line);
        if (presetRet) {
          if (!ymdSameOrAfter(presetRet, st.outboundYmd)) {
            await ctx.reply(
              'Дата возврата получилась раньше «туда» — выбери позже или введи вручную.',
              this.subscribeWizardKb(chatId, st),
            );
            return;
          }
          await this.finishSubscribeWizard(ctx, route, st.outboundYmd, presetRet);
          return;
        }
        if (line === BTN_RETURN_DATE_CUSTOM) {
          const nextSt: SubscribeWizardState = {
            step: 'await_return_custom',
            outboundYmd: st.outboundYmd,
            ...route,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            'Дата обратно — ДД.ММ.ГГГГ или ГГГГ‑ММ‑ДД (не раньше даты «туда»).',
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        const typedR = parseDateToken(line);
        if (!typedR) {
          await ctx.reply(
            'Выбери пресет, «Своя дата обратно» или напиши дату.',
            this.subscribeWizardKb(chatId, st),
          );
          return;
        }
        if (!ymdSameOrAfter(typedR, st.outboundYmd)) {
          await ctx.reply(
            'Обратный вылет не может быть раньше «туда».',
            this.subscribeWizardKb(chatId, st),
          );
          return;
        }
        await this.finishSubscribeWizard(ctx, route, st.outboundYmd, typedR);
        break;
      }
      case 'await_return_custom': {
        const route: SubscribeWizardRoute = {
          originRaw: st.originRaw,
          originCode: st.originCode,
          displayO: st.displayO,
          destRaw: st.destRaw,
          destCode: st.destCode,
          displayD: st.displayD,
        };
        if (line === BTN_RETURN_BACK_SHAPE) {
          const nextSt: SubscribeWizardState = {
            step: 'await_return_date',
            outboundYmd: st.outboundYmd,
            ...route,
          };
          this.subscribeWizardByChat.set(chatId, nextSt);
          await ctx.reply(
            'Снова выбери способ указания даты обратного вылета.',
            this.subscribeWizardKb(chatId, nextSt),
          );
          return;
        }
        const typedR = parseDateToken(line);
        if (!typedR) {
          await ctx.reply('Например: 18.06.2026', this.subscribeWizardKb(chatId, st));
          return;
        }
        if (!ymdSameOrAfter(typedR, st.outboundYmd)) {
          await ctx.reply(
            'Обратный вылет не может быть раньше «туда».',
            this.subscribeWizardKb(chatId, st),
          );
          return;
        }
        await this.finishSubscribeWizard(ctx, route, st.outboundYmd, typedR);
        break;
      }
    }
  }

  private async activateSubscription(
    ctx: Context,
    parsed: ParsedSubscribe,
  ): Promise<void> {
    const { originCode, destCode, displayO, displayD, ymd, returnYmd } =
      parsed;
    const chatId = ctx.chat!.id;

    const pollMs = Number(this.config.get('PRICE_POLL_INTERVAL_MS', 1000));
    const fetchMs = Number(this.config.get('FETCH_INTERVAL_MS', 120_000));
    const isBrowserMode = this.priceSource() !== 'travelpayouts';

    const id = this.nextSubId(chatId);
    const bookingUrl = this.listingBookingUrl(
      chatId,
      originCode,
      destCode,
      ymd,
      returnYmd,
    );

    const state: SubState = {
      id,
      ymd,
      returnYmd,
      originCode,
      destCode,
      displayO,
      displayD,
      lastFetch: 0,
      lastHourlyDigestAt: 0,
      lastResult: null,
      lastResultReturn: null,
      lastVisual: null,
      lastApiError: null,
      lastErrorNotified: null,
      priorCarriers: null,
      priorCheapState: null,
      priorCheapReturnState: null,
      alertMaxRub: null,
      alertMinDropRub: null,
      alertMinDropPercent: null,
      lastSuccessfulFetchAt: 0,
      timer: undefined as unknown as NodeJS.Timeout,
    };

    const subs = this.subsFor(chatId);
    subs.set(id, state);

    state.timer = setInterval(() => {
      void this.subscriptionTick(chatId, id, pollMs, fetchMs);
    }, pollMs);

    void this.subscriptionTick(chatId, id, pollMs, fetchMs);

    const prefNote =
      this.notifyPreferenceFor(chatId) === 'on_change'
        ? 'Пишу при изменении цены · настройки снизу для всех ваших подписок в этом чате.'
        : 'Интервал сводки меняешь в «Настройках» — действует для всех подписок чата.';

    let routeHum = `${displayO} → ${displayD} · ${ymdToIso(ymd)}`;
    if (returnYmd != null) routeHum += ` · ⇄ ${ymdToIso(returnYmd)}`;

    const chunks: string[] = [
      `✅ Подписка #${id} · ${routeHum}`,
      prefNote,
      'Пороги при «изменении»: /filter · тихие часы: /quiet · сводка: /status',
    ];
    if (chatId < 0)
      chunks.push('Дубликат сообщений себе в личку без кнопок: команда /mirror в группе.');
    if (isBrowserMode) chunks.push('Скрин и сайт выдачи (Авиасейлс/Купибилет) — в «Настройках».');

    await ctx.reply(chunks.join('\n\n'), inlinePurchaseAndUnsubscribe(bookingUrl, id));
    await ctx.reply('\u2060', this.replyKb(chatId));
    this.flashTransientStickerLater(chatId, this.uxAssets.stickerSuccess);
  }

  /** Уведомление по парсингу Авиасейлс: при включённом фото — JPEG + подпись Markdown (до 1024 симв.). */
  private async sendAviasalesMarkdownPhoto(
    chatId: number,
    markdown: string,
    photo: Buffer | undefined,
    attachPhoto: boolean,
    purchaseKb: ReturnType<typeof inlinePurchaseAndUnsubscribe>,
  ): Promise<void> {
    const usePic =
      attachPhoto &&
      photo !== undefined &&
      Buffer.isBuffer(photo) &&
      photo.length >= 2048;
    if (usePic) {
      const cap =
        markdown.length > 1024
          ? markdown.slice(0, 1018) + ' …'
          : markdown;
      await this.bot.telegram
        .sendChatAction(chatId, 'upload_photo')
        .catch(() => undefined);
      await this.bot.telegram.sendPhoto(
        chatId,
        { source: photo, filename: 'aviasales.jpg' },
        {
          caption: cap,
          parse_mode: 'Markdown',
          ...purchaseKb,
        },
      );
      return;
    }
    await this.bot.telegram.sendMessage(chatId, markdown, {
      parse_mode: 'Markdown',
      link_preview_options: { is_disabled: true },
      ...purchaseKb,
    });
  }

  private async subscriptionTick(
    chatId: number,
    subId: number,
    _pollMs: number,
    fetchMs: number,
  ): Promise<void> {
    const subs = this.byChat.get(chatId);
    const sub = subs?.get(subId);
    if (!sub) return;

    const bookingUrl = this.listingBookingUrl(
      chatId,
      sub.originCode,
      sub.destCode,
      sub.ymd,
      sub.returnYmd,
    );
    const listingMdLink = `[${this.listingLinkMarkdownLabel(chatId)}](${bookingUrl})`;
    const cheapMdLink = `[Авиасейлс](${bookingUrl})`;
    const mode = this.priceSource();
    const now = Date.now();
    const departIso = ymdToIso(sub.ymd);
    const returnIso =
      sub.returnYmd != null ? ymdToIso(sub.returnYmd) : null;

    let refreshed = false;
    try {
      if (now - sub.lastFetch >= fetchMs) {
        refreshed = true;
        sub.lastFetch = now;
        if (mode === 'travelpayouts') {
          sub.lastVisual = null;
          sub.lastResult = await this.prices.fetchCheapest(
            sub.originCode,
            sub.destCode,
            departIso,
          );
          const errs: string[] = [];
          if (!sub.lastResult.success)
            errs.push(
              `туда: ${String(sub.lastResult.error ?? 'ошибка Cheap API')}`,
            );
          sub.lastResultReturn = null;
          if (returnIso != null) {
            sub.lastResultReturn = await this.prices.fetchCheapest(
              sub.destCode,
              sub.originCode,
              returnIso,
            );
            if (!sub.lastResultReturn.success)
              errs.push(
                `обратно: ${String(sub.lastResultReturn.error ?? 'ошибка Cheap API')}`,
              );
          }
          sub.lastApiError = errs.length > 0 ? errs.join(' · ') : null;
        } else {
          sub.lastResult = null;
          sub.lastResultReturn = null;
          void this.bot.telegram
            .sendChatAction(
              chatId,
              this.attachScreenshotFor(chatId) ? 'upload_photo' : 'typing',
            )
            .catch(() => undefined);
          sub.lastVisual = await this.aviasalesShot.fetchSearchCarrierPrices(
            bookingUrl,
            { screenshot: this.attachScreenshotFor(chatId) },
          );
          sub.lastApiError = sub.lastVisual.error
            ? sub.lastVisual.error
            : !sub.lastVisual.success
              ? 'не удалось обработать выдачу'
              : null;
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      sub.lastApiError = msg;
      this.log.warn(`${chatId}/${subId} fetch error: ${msg}`);
    }

    if (!refreshed) return;

    if (!sub.lastApiError) sub.lastSuccessfulFetchAt = now;

    const purchaseKb = inlinePurchaseAndUnsubscribe(bookingUrl, subId);
    const pref = this.notifyPreferenceFor(chatId);
    const wantListingPhoto =
      mode !== 'travelpayouts' && this.attachScreenshotFor(chatId);
    const hourlyMs = this.effectiveDigestIntervalMs(chatId);
    const hourlyDue =
      sub.lastHourlyDigestAt === 0 ||
      now - sub.lastHourlyDigestAt >= hourlyMs;

    const dirLine = subscriptionDirLineTelegram(sub);
    const when = new Date(now);

    try {
      if (sub.lastApiError) {
        if (pref === 'hourly') {
          if (hourlyDue) {
            const quiet = this.isQuietHours(chatId, when);
            if (!quiet) {
              sub.lastHourlyDigestAt = now;
              sub.lastErrorNotified = sub.lastApiError;
              const plain = `${dirLine}\n⏰ Сводка по интервалу\n${subscriptionDigestDatesRu(sub)}\n\n⚠️ ${this.plainTechAlertForTelegram(sub.lastApiError)}\n\n${bookingUrl}`;
              await this.bot.telegram.sendMessage(chatId, plain, {
                link_preview_options: { is_disabled: true },
                ...purchaseKb,
              });
              void this.mirrorPlainIfGroup(chatId, plain);
            }
          }
        } else if (sub.lastErrorNotified !== sub.lastApiError) {
          const quiet = this.isQuietHours(chatId, when);
          if (!quiet) {
            sub.lastErrorNotified = sub.lastApiError;
            const plain = `${dirLine}\n\n⚠️ ${this.plainTechAlertForTelegram(sub.lastApiError)}\n\n${bookingUrl}`;
            await this.bot.telegram.sendMessage(chatId, plain, {
              link_preview_options: { is_disabled: true },
              ...purchaseKb,
            });
            void this.mirrorPlainIfGroup(chatId, plain);
          }
        }
        return;
      }
      sub.lastErrorNotified = null;

      if (pref === 'hourly') {
        if (mode === 'travelpayouts') {
          const r = sub.lastResult;
          if (!r) return;

          const curO = snapshotCheap(r);
          const rr = sub.lastResultReturn;
          const curR =
            sub.returnYmd != null && rr != null ? snapshotCheap(rr) : null;

          sub.priorCheapState = curO;
          sub.priorCheapReturnState = curR;

          if (!hourlyDue) return;
          if (this.isQuietHours(chatId, when)) return;

          sub.lastHourlyDigestAt = now;

          let cap = this.cheapResultDigestCaption(r);
          if (sub.returnYmd != null && rr != null) {
            cap += `\nобратно · ${this.cheapResultDigestCaption(rr)}`;
          }
          const md = `${this.escapeMd(dirLine)}\n⏰ Сводка по интервалу\n${this.escapeMd(subscriptionDigestDatesRu(sub))}\n${this.escapeMd(cap)}\n${cheapMdLink}`;
          await this.bot.telegram.sendMessage(chatId, md, {
            parse_mode: 'Markdown',
            link_preview_options: { is_disabled: true },
            ...purchaseKb,
          });
          void this.mirrorMarkdownIfGroup(chatId, md);
          return;
        }

        const v = sub.lastVisual;
        if (!v?.success) return;
        const carriers = normalizeCarriers(v.carrierPrices);
        sub.priorCarriers = cloneCarrierPrices(carriers);

        if (!hourlyDue) return;
        if (this.isQuietHours(chatId, when)) return;

        sub.lastHourlyDigestAt = now;

        const carrierLinesPlain = carriers.map((c) =>
          formatCarrierOfferLineRu(c, (n) => this.fmtRub(n)),
        );
        const listingEsc =
          carrierLinesPlain.length > 0
            ? carrierLinesPlain.map((s) => this.escapeMd(s)).join('\n')
            : this.escapeMd(
                'В тексте страницы не найдены суммы в ₽ — проверьте выдачу по ссылке.',
              );
        const digestMd =
          `${this.escapeMd(dirLine)}\n⏰ Сводка по интервалу\n${this.escapeMd(subscriptionDigestDatesRu(sub))}\n${listingEsc}\n${listingMdLink}`;
        let photoDigest = v.screenshot;
        if (wantListingPhoto && photoDigest?.length) {
          photoDigest = await this.applyFlightDigestOverlay(
            photoDigest,
            this.buildHourlyDigestCardPayload(sub, carrierLinesPlain),
          );
        }
        await this.sendAviasalesMarkdownPhoto(
          chatId,
          digestMd,
          photoDigest,
          wantListingPhoto,
          purchaseKb,
        );
        this.mirrorAviasalesDigestIfGroup(
          chatId,
          digestMd,
          photoDigest,
          wantListingPhoto,
        );
        return;
      }

      /* --- режим: только при изменении --- */

      if (mode === 'travelpayouts') {
        const r = sub.lastResult;
        if (!r) return;
        const curO = snapshotCheap(r);
        const rr = sub.lastResultReturn;
        const curR =
          sub.returnYmd != null && rr != null ? snapshotCheap(rr) : null;
        const priorR =
          sub.returnYmd != null ? sub.priorCheapReturnState : null;

        if (!sub.priorCheapState) {
          sub.priorCheapState = curO;
          sub.priorCheapReturnState = curR;
          return;
        }
        const priorO = sub.priorCheapState;
        const line = explainCheapRtChange(
          priorO,
          curO,
          priorR,
          curR,
          (n) => this.fmtRub(n),
        );
        if (!line) return;

        sub.priorCheapState = curO;
        sub.priorCheapReturnState = curR;

        const pass = passesCheapRtChangeAlerts(
          sub.alertMaxRub,
          sub.alertMinDropRub,
          sub.alertMinDropPercent,
          priorO,
          curO,
          priorR,
          curR,
        );
        if (!pass || this.isQuietHours(chatId, when)) return;
        const md = [
          this.escapeMd(dirLine),
          this.escapeMd(line),
          cheapMdLink,
        ].join('\n');
        await this.bot.telegram.sendMessage(chatId, md, {
          parse_mode: 'Markdown',
          link_preview_options: { is_disabled: true },
          ...purchaseKb,
        });
        void this.mirrorMarkdownIfGroup(chatId, md);
        return;
      }

      const v = sub.lastVisual;
      if (!v?.success) return;
      const carriers = normalizeCarriers(v.carrierPrices);
      if (!sub.priorCarriers) {
        sub.priorCarriers = cloneCarrierPrices(carriers);
        return;
      }
      const moves = describeCarrierPriceMoves(
        sub.priorCarriers,
        carriers,
        (n) => this.fmtRub(n),
      );
      if (moves.length === 0) return;
      const priorSnapshot = cloneCarrierPrices(sub.priorCarriers);
      sub.priorCarriers = cloneCarrierPrices(carriers);
      const pass = passesCarrierPriceAlerts(
        sub.alertMaxRub,
        sub.alertMinDropRub,
        sub.alertMinDropPercent,
        priorSnapshot,
        carriers,
      );
      if (!pass || this.isQuietHours(chatId, when)) return;
      const md = [
        this.escapeMd(dirLine),
        ...moves.map((s) => this.escapeMd(s)),
        listingMdLink,
      ].join('\n');
      let photoAlert = v.screenshot;
      if (wantListingPhoto && photoAlert?.length) {
        photoAlert = await this.applyFlightDigestOverlay(photoAlert, {
          routeTitle: `#${sub.id} · ${sub.displayO} → ${sub.displayD}`,
          datesLine: subscriptionDigestDatesRu(sub),
          lines: moves.length > 0 ? moves : ['Изменение по выдаче'],
        });
      }
      await this.sendAviasalesMarkdownPhoto(
        chatId,
        md,
        photoAlert,
        wantListingPhoto,
        purchaseKb,
      );
      this.mirrorAviasalesDigestIfGroup(
        chatId,
        md,
        photoAlert,
        wantListingPhoto,
      );
    } catch (e) {
      this.log.warn(`send failed ${chatId}: ${String(e)}`);
    }
  }

  private fmtRub(n: number): string {
    return `${n.toLocaleString('ru-RU')} ₽`;
  }

  private escapeMd(s: string): string {
    return s.replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
  }

  /** Без Markdown: длинные ошибки Playwright с ANSI/`Call log` ломали Telegram и давали `\#`, `\-` в тексте. */
  private plainTechAlertForTelegram(err: string): string {
    const s = err.replace(/\u001b\[[\d;]*m/g, '').trim();
    const cut = /\n\s*call log\s*:/i.exec(s);
    let head =
      cut != null ? s.slice(0, cut.index).trim() : (s.split('\n')[0] ?? s).trim();
    if (/timeout\b.*exceeded|90000\b.*timeout/i.test(head))
      return 'Страница выдачи не загрузилась вовремя · повтор на следующей проверке';
    const oneLine = head.replace(/\s+/g, ' ');
    return oneLine.length > 280 ? `${oneLine.slice(0, 277)}…` : oneLine;
  }

  private async onInlineUnsubscribe(ctx: Context): Promise<void> {
    const cq = ctx.callbackQuery;
    if (!cq || !('data' in cq) || !ctx.chat?.id) {
      await ctx.answerCbQuery();
      return;
    }
    const m = /^u:(\d+)$/.exec(cq.data || '');
    if (!m) {
      await ctx.answerCbQuery('Не сработало');
      return;
    }
    const sid = Number(m[1]);
    const ok = this.stopSubscription(ctx.chat.id, sid);
    await ctx.answerCbQuery(ok ? 'Готово' : 'Не найдено');
    try {
      await ctx.editMessageReplyMarkup({ inline_keyboard: [] });
    } catch {
      /* */
    }
  }

  private async onUnsubscribeAllViaButton(ctx: Context): Promise<void> {
    const chatId = ctx.chat?.id;
    if (chatId == null) return;
    this.clearAllSubscriptions(chatId);
    await ctx.reply('Все подписки отключены.', this.replyKb(ctx.chat!.id));
  }

  private async onUnsubscribe(ctx: Context): Promise<void> {
    const text = this.messageText(ctx) ?? '';
    const rest = text.replace(/^\/unsubscribe(@\w+)?\s*/i, '').trim();
    const chatId = ctx.chat!.id;
    if (!rest) {
      this.clearAllSubscriptions(chatId);
      await ctx.reply('Очистил список подписок.', this.replyKb(ctx.chat!.id));
      return;
    }
    const sid = Number(rest);
    if (!Number.isFinite(sid)) {
      await ctx.reply('Номер из списка «Мои подписки» или кнопка «Отписаться» под сообщением.', this.replyKb(ctx.chat!.id));
      return;
    }
    const ok = this.stopSubscription(chatId, sid);
    if (!ok) {
      await ctx.reply(`#${sid} — нет такой.`, this.replyKb(ctx.chat!.id));
      return;
    }
    await ctx.reply(`#${sid} снята`, this.replyKb(ctx.chat!.id));
  }

  private async onList(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const subs = this.subsFor(chatId);
    if (!subs.size) {
      await ctx.reply(
        '📋 Пока подписок нет. Начни с кнопки «Подписаться» под полем ввода.',
        this.replyKb(ctx.chat!.id),
      );
      return;
    }
    const prefLine =
      this.notifyPreferenceFor(chatId) === 'on_change'
        ? 'Режим · при изменении цены'
        : `Режим · сводка ≈ каждые ${this.fmtDigestMsHuman(this.effectiveDigestIntervalMs(chatId))}`;
    const shotLine =
      this.priceSource() !== 'travelpayouts'
        ? this.attachScreenshotFor(chatId)
          ? '📸 Со скрином страницы выдачи'
          : '📸 Только текст выдачи'
        : '';

    const siteLine =
      this.priceSource() === 'travelpayouts'
        ? '🌐 Источник: Cheap API · билет через Авиасейлс'
        : `🌐 Выдача: ${this.flightListingSiteFor(chatId) === 'kupibilet' ? 'Купибилет' : 'Авиасейлс'}`;
    const lines = [...subs.values()].map((s) => {
      let t = `#${s.id}: ${s.displayO} (${s.originCode}) → ${s.displayD} (${s.destCode}), ${ymdToIso(s.ymd)}`;
      if (s.returnYmd != null) t += ` · ⇄ ${ymdToIso(s.returnYmd)}`;
      t += ` · ${formatFiltersLine(s)}`;
      return t;
    });
    const head: string[] = [prefLine, siteLine];
    if (shotLine) head.push(shotLine);
    await ctx.reply([...head, '', lines.join('\n')].join('\n'), this.replyKb(ctx.chat!.id));
  }

  private messageText(ctx: Context): string | undefined {
    const m = ctx.message;
    return m && 'text' in m ? m.text : undefined;
  }

  private subsFor(chatId: number): Map<number, SubState> {
    let g = this.byChat.get(chatId);
    if (!g) {
      g = new Map();
      this.byChat.set(chatId, g);
    }
    return g;
  }

  private clearAllSubscriptions(chatId: number): void {
    const subs = this.subsFor(chatId);
    for (const s of subs.values()) clearInterval(s.timer);
    subs.clear();
  }

  private stopSubscription(chatId: number, subId: number): boolean {
    const subs = this.byChat.get(chatId);
    const st = subs?.get(subId);
    if (!st) return false;
    clearInterval(st.timer);
    subs!.delete(subId);
    return true;
  }

  private nextSubId(chatId: number): number {
    const subs = this.subsFor(chatId);
    let m = 0;
    for (const id of subs.keys()) m = Math.max(m, id);
    return m + 1;
  }

  /** Импорт полной строки Kupibilet (route[0], необязательно route[1]). */
  private async tryImportKupibilet(
    raw: string,
  ): Promise<ParsedSubscribe | { error: string } | null> {
    if (!looksLikeKupibiletFlightUrl(raw)) return null;

    let u: URL;
    try {
      u = new URL(
        /^https?:\/\//i.test(raw.trim())
          ? raw.trim()
          : `https://${raw.trim()}`,
      );
    } catch {
      return null;
    }

    const tuples = sortedKupibiletRouteTuples(u).slice(0, 2);
    if (!tuples.length)
      return {
        error:
          'Вижу Kupibilet, но нет параметров route[…]=iatax:…. Скопируй адрес из браузера целиком.',
      };

    const parsedSegs = tuples.map(({ val }) =>
      parseKupibiletRouteToken(val),
    );
    const badIdx = parsedSegs.findIndex((p) => p == null);
    if (badIdx >= 0)
      return {
        error:
          'Не разобрал один из сегментов route[N] · ожидался формат iatax:AAA_YYYY-MM-DD_date_YYYY-MM-DD_iatax:BBB.',
      };

    const a = parsedSegs[0]!;
    if (parsedSegs.length === 1) {
      const [o, d] = await Promise.all([
        this.cities.resolveCity(a.originCode),
        this.cities.resolveCity(a.destCode),
      ]);
      if (!o || !d)
        return {
          error: `Не нашёл город по коду из ссылки: «${a.originCode}» → «${a.destCode}».`,
        };
      if (o.code === d.code) return { error: 'Откуда и куда в ссылке совпадают.' };
      return {
        originCode: o.code,
        destCode: d.code,
        displayO: o.name,
        displayD: d.name,
        ymd: a.ymd,
        returnYmd: null,
      };
    }

    const b = parsedSegs[1]!;
    if (
      a.destCode !== b.originCode ||
      b.destCode !== a.originCode
    )
      return {
        error:
          'В Kupibilet два перелёта, но они не пара «туда‑обратно» между одинаковыми аэропортами.',
      };
    if (ymdSortKey(b.ymd) < ymdSortKey(a.ymd))
      return {
        error: 'Дата обратного перелёта в ссылке раньше даты «туда».',
      };

    const [o, d] = await Promise.all([
      this.cities.resolveCity(a.originCode),
      this.cities.resolveCity(a.destCode),
    ]);
    if (!o || !d)
      return {
        error:
          `Не нашёл город по коду из ссылки: «${a.originCode}» → «${a.destCode}».`,
      };
    if (o.code === d.code) return { error: 'Откуда и куда в ссылке совпадают.' };

    return {
      originCode: o.code,
      destCode: d.code,
      displayO: o.name,
      displayD: d.name,
      ymd: a.ymd,
      returnYmd: b.ymd,
    };
  }

  /** Распознать URL или код поиска Авиасейлс (туда или туда‑обратно в одном сегменте). */
  private async tryImportAviasales(
    raw: string,
  ): Promise<ParsedSubscribe | { error: string } | null> {
    const slug = extractAviasalesSearchSlug(raw);
    if (slug == null) return null;

    const struct = parseAviasalesSlugStructure(slug);
    if (!struct)
      return {
        error:
          'Не понял ссылку или код из поиска. Например LED1505SVX1 или туда‑обратно LED1505SVX18051.',
      };

    const today = calendarYmdInTz(new Date(), SUBSCRIBE_WIZARD_MSK_TZ);

    let outYmd: Ymd | null = null;
    let retYmd: Ymd | null = null;

    if (!struct.rt) {
      outYmd = ymdFromDdMmPreferFuture(
        { d: struct.outDay, m: struct.outMonth },
        today,
      );
    } else {
      outYmd = ymdFromDdMmPreferFuture(
        { d: struct.outDay, m: struct.outMonth },
        today,
      );
      if (!outYmd)
        return {
          error:
            'Не удалось сопоставить дату «туда» из ссылки — проверь ДДММ между кодами городов.',
        };
      retYmd = expandDdMmAnchored(
        struct.retDay,
        struct.retMonth,
        outYmd,
      );
      if (!retYmd)
        return {
          error:
            'Не удалось сопоставить дату возврата из ссылки (ДДММ после кода города прилёта).',
        };
    }

    if (!outYmd)
      return {
        error:
          'Не удалось сопоставить дату из ссылки — проверь ДДММ между кодами городов.',
      };

    const [o, d] = await Promise.all([
      this.cities.resolveCity(struct.originCode),
      this.cities.resolveCity(struct.destCode),
    ]);
    if (!o || !d)
      return {
        error:
          `Не нашёл город по коду из ссылки: «${struct.originCode}» → «${struct.destCode}». Попробуй /subscribe текстом.`,
      };
    if (o.code === d.code) return { error: 'Откуда и куда в ссылке совпадают.' };

    return {
      originCode: o.code,
      destCode: d.code,
      displayO: o.name,
      displayD: d.name,
      ymd: outYmd,
      returnYmd: struct.rt && retYmd ? retYmd : null,
    };
  }

  /** Одноразовый запрос цены для подсказки «Пора проверить». Состояние подписок и таймеры не трогаем. */
  private async formatManualCheckSubLine(
    chatId: number,
    sub: SubState,
  ): Promise<string> {
    const iso = ymdToIso(sub.ymd);
    const retIso = sub.returnYmd != null ? ymdToIso(sub.returnYmd) : null;

    const url = this.listingBookingUrl(
      chatId,
      sub.originCode,
      sub.destCode,
      sub.ymd,
      sub.returnYmd,
    );
    let headline = `#${sub.id} · ${sub.displayO} (${sub.originCode}) → ${sub.displayD} (${sub.destCode}), ${iso}`;
    if (sub.returnYmd != null && retIso != null)
      headline += `\n⇄ обратно ${retIso}`;

    const mode = this.priceSource();
    try {
      if (mode === 'travelpayouts') {
        const rOut = await this.prices.fetchCheapest(
          sub.originCode,
          sub.destCode,
          iso,
        );
        let body = this.cheapResultDigestCaption(rOut);
        if (retIso != null) {
          const rRet = await this.prices.fetchCheapest(
            sub.destCode,
            sub.originCode,
            retIso,
          );
          body += `\nобратно · ${this.cheapResultDigestCaption(rRet)}`;
        }
        return `${headline}\n${body}\n${url}`;
      }

      const v = await this.aviasalesShot.fetchSearchCarrierPrices(url, {
        screenshot: false,
      });

      if (v.error || !v.success) {
        const err = String(v.error ?? 'не удалось обработать выдачу');
        return `${headline}\n⚠️ ${this.plainTechAlertForTelegram(err)}\n${url}`;
      }

      const carriers = normalizeCarriers(v.carrierPrices);
      const lines = carriers.map((c) =>
        formatCarrierOfferLineRu(c, (n) => this.fmtRub(n)),
      );
      const listing =
        lines.length > 0
          ? lines.join('\n')
          : 'В тексте страницы не найдены суммы в ₽ — проверьте выдачу по ссылке.';
      return `${headline}\n${listing}\n${url}`;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return `${headline}\n⚠️ ${this.plainTechAlertForTelegram(msg)}\n${url}`;
    }
  }

  private async onManualCheckSubscriptions(ctx: Context): Promise<void> {
    const chatId = ctx.chat!.id;
    const kb = this.replyKb(chatId);
    const forumThreadExtra =
      ctx.chat?.type === 'supergroup' &&
      typeof ctx.message?.message_thread_id === 'number'
        ? { message_thread_id: ctx.message.message_thread_id }
        : {};

    const subsMap = this.subsFor(chatId);
    const n = subsMap.size;

    if (n === 0) {
      await ctx.reply('📭 Пока без подписок — нечего проверять.', kb);
      return;
    }

    const nowMs = Date.now();
    const prev = this.lastManualCheckAtMsByChat.get(chatId) ?? 0;
    if (prev > 0 && nowMs - prev < MANUAL_CHECK_COOLDOWN_MS) {
      const waitSec = Math.ceil((MANUAL_CHECK_COOLDOWN_MS - (nowMs - prev)) / 1000);
      this.flashTransientStickerLater(chatId, this.uxAssets.stickerCooldown, 3400);
      await ctx.reply(
        `⏳ Повтори через ${waitSec} сек. (защита от спама, интервал ${MANUAL_CHECK_COOLDOWN_MS / 60_000} мин)`,
        kb,
      );
      return;
    }
    this.lastManualCheckAtMsByChat.set(chatId, nowMs);

    /** Удалить после финального текста («ожидание», стикер, GIF). */
    const ephemeralDecorationIds: number[] = [];

    const animId = await this.sendAnimationBestEffort(
      chatId,
      this.uxAssets.animationLoading,
    );
    if (animId != null) ephemeralDecorationIds.push(animId);

    const preStickerId = await this.sendStickerBestEffort(
      chatId,
      this.uxAssets.stickerChecking,
    );
    if (preStickerId != null) ephemeralDecorationIds.push(preStickerId);

    void ctx.telegram.sendChatAction(chatId, 'typing');

    const pendingMsg =
      `⏳ Идёт проверка цен по подпискам (${n})… Запрашиваю источники; результат придёт в этот чат — обычно до пары минут.`;
    const pending = await ctx.reply(pendingMsg, kb);
    const pendingMessageId = pending.message_id;

    const sorted = [...subsMap.values()].sort((a, b) => a.id - b.id);
    const chunks = await Promise.all(
      sorted.map((sub) => this.formatManualCheckSubLine(chatId, sub)),
    );

    let body =
      `🔔 Снимок цен по ${n} билетам (без скринов, только запрос к источнику):\n\n` +
      chunks.join('\n\n');

    body += `\n\n⏳ Следующая ручная проверка этого чата — не раньше чем через ${MANUAL_CHECK_COOLDOWN_MS / 60_000} мин. Автоопрос подписок продолжается как раньше.`;

    const slices = splitTelegramPlainChunks(body);
    try {
      if (slices.length === 1) {
        for (const id of ephemeralDecorationIds) {
          await this.deleteMessageBestEffort(chatId, id, true);
        }
        try {
          await ctx.telegram.editMessageText(
            chatId,
            pendingMessageId,
            undefined,
            slices[0],
            {
              link_preview_options: { is_disabled: true },
              ...forumThreadExtra,
            },
          );
          void this.mirrorPlainIfGroup(chatId, slices[0]);
        } catch (editErr) {
          this.log.warn(
            `manual_check editMessageText chat=${chatId} msg=${pendingMessageId}: ${telegramErrorDescription(editErr)}`,
          );
          await this.deleteMessageBestEffort(chatId, pendingMessageId, true);
          await ctx.reply(slices[0], {
            link_preview_options: { is_disabled: true },
            ...kb,
          });
          void this.mirrorPlainIfGroup(chatId, slices[0]);
        }
        return;
      }

      for (const id of [...ephemeralDecorationIds, pendingMessageId]) {
        await this.deleteMessageBestEffort(chatId, id, true);
      }

      for (const part of slices) {
        await ctx.reply(part, {
          link_preview_options: { is_disabled: true },
          ...kb,
        });
        void this.mirrorPlainIfGroup(chatId, part);
      }
    } catch (e) {
      this.log.warn(`manual check send ${chatId}: ${String(e)}`);
      for (const id of ephemeralDecorationIds) {
        await this.deleteMessageBestEffort(chatId, id, true);
      }
      try {
        await ctx.telegram.editMessageText(
          chatId,
          pendingMessageId,
          undefined,
          `Не удалось отправить ответ: ${String(e)}`,
          {
            link_preview_options: { is_disabled: true },
            ...forumThreadExtra,
          },
        );
      } catch (editFail) {
        this.log.warn(
          `manual_check error-edit chat=${chatId} msg=${pendingMessageId}: ${telegramErrorDescription(editFail)}`,
        );
        await this.deleteMessageBestEffort(chatId, pendingMessageId, true);
        await ctx.reply(`Не удалось отправить ответ: ${String(e)}`, kb);
      }
    }
  }

  private async parseSubscribePayload(
    rest: string,
  ): Promise<ParsedSubscribe | { error: string }> {
    const fromKup = await this.tryImportKupibilet(rest);
    if (fromKup !== null) return fromKup;

    const fromLink = await this.tryImportAviasales(rest);
    if (fromLink !== null) return fromLink;

    const piped = rest
      .split('|')
      .map((x) => x.trim())
      .filter(Boolean);

    let originRaw: string;
    let destRaw: string;
    let dateRaw: string;

    if (piped.length === 3) {
      [originRaw, destRaw, dateRaw] = piped;
    } else {
      const iata = /^([a-z]{3})\s+([a-z]{3})\s+(\S+)$/i.exec(rest.trim());
      if (!iata) {
        const candidates = enumerateSpaceSeparatedSubscribe(rest.trim());
        const successes: ParsedSubscribe[] = [];

        for (const c of candidates) {
          const ymdSpace = parseDateToken(c.dateRaw);
          if (!ymdSpace) continue;
          const o = await this.cities.resolveCity(c.originRaw);
          const d = await this.cities.resolveCity(c.destRaw);
          if (!o || !d || o.code === d.code) continue;
          successes.push({
            originCode: o.code,
            destCode: d.code,
            displayO: o.name,
            displayD: d.name,
            ymd: ymdSpace,
            returnYmd: null,
          });
        }

        const uniqSpace = dedupeParsedSubscribe(successes);
        if (uniqSpace.length === 1) return uniqSpace[0];
        if (uniqSpace.length === 0) {
          return {
            error:
              'Не разобрал текст. Формат: город откуда, город куда, дата или «город | город | дата»; можно /subscribe со ссылкой aviasales.ru/search/… или kupibilet.ru/search?…',
          };
        }
        return {
          error:
            'Много вариантов — уточни: Город | Город | дата или оформи через «Подписаться».',
        };
      }
      [, originRaw, destRaw, dateRaw] = iata;
    }

    const ymd = parseDateToken(dateRaw);
    if (!ymd)
      return { error: 'Дата неверная. Форматы: 15.06.2026 или 2026-06-15' };

    const o = await this.cities.resolveCity(originRaw);
    const d = await this.cities.resolveCity(destRaw);
    if (!o)
      return {
        error: `Города вылета нет («${originRaw}»). Попробуй IATA (LED).`,
      };
    if (!d) return { error: `Прилёт «${destRaw}» не найден.` };
    if (o.code === d.code) return { error: 'Откуда и куда совпадают.' };

    return {
      originCode: o.code,
      destCode: d.code,
      displayO: o.name,
      displayD: d.name,
      ymd,
      returnYmd: null,
    };
  }
}
