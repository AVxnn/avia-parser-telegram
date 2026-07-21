import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { existsSync } from 'fs';
import { carrierRowsFromPageInnerText } from './aviasales-listing-parse';
import type { AviasalesVisualSnapshot, CarrierRubPrice } from './aviasales-visual.types';

function stripAnsi(s: string): string {
  return s.replace(/\u001b\[[\d;]*m/g, '');
}

function shortenPlaywrightErrorMessage(raw: string): string {
  const s = stripAnsi(raw).trim();
  const cut = /\n\s*call log\s*:/i.exec(s);
  const head = cut ? s.slice(0, cut.index).trim() : s;
  if (/timeout\b.*exceeded|exceeded\b.*timeout/i.test(head))
    return 'Страница выдачи не загрузилась вовремя (таймаут).';
  return head.replace(/\s+/g, ' ').slice(0, 320);
}

export type FlightListingSite = 'aviasales' | 'kupibilet';

export function inferFlightListingSiteFromUrl(searchUrl: string): FlightListingSite {
  try {
    const h = new URL(searchUrl).hostname.toLowerCase();
    return h.includes('kupibilet') ? 'kupibilet' : 'aviasales';
  } catch {
    return /kupibilet\.(?:ru|com)/i.test(searchUrl) ? 'kupibilet' : 'aviasales';
  }
}

export function extractCarrierRubPrices(raw: string): CarrierRubPrice[] {
  return carrierRowsFromPageInnerText('aviasales', raw).map((r) => ({
    carrier: r.carrier,
    price: r.price,
    departureTime: r.departureTime,
    returnDepartureTime: r.returnDepartureTime,
  }));
}

export function extractRubleLikeAmounts(raw: string): number[] {
  const s = raw
    .replace(/\u00A0/g, ' ')
    .replace(/\u202f/g, ' ');
  const out = new Set<number>();
  const re =
    /(?:^|[^\d\u20BD])(\d{1,3}(?:[ \u202f\u00A0]\d{3})+|\d{2,})\s*₽/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    const n = parseInt(m[1].replace(/\D/g, ''), 10);
    if (Number.isFinite(n) && n >= 99 && n <= 10_000_000) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

function suggestsCaptchaBlocking(text: string): boolean {
  const t = text.toLowerCase();
  const keys = [
    'капч',
    'captcha',
    'подозрительн',
    'робот',
    'не робот',
    'проверк',
    'доступ огранич',
    'доступ временно огранич',
    'слишком много запрос',
    'unusual traffic',
    'checking your browser',
    'automated requests',
    'sorry, you have been blocked',
    'sorry, unable to process',
  ];
  return keys.some((k) => t.includes(k));
}

@Injectable()
export class AviasalesScreenshotService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly log = new Logger(AviasalesScreenshotService.name);
  private captureLock: Promise<void> = Promise.resolve();
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;

  constructor(private readonly config: ConfigService) {}

  async onModuleInit(): Promise<void> {
    if (!this.isEnabled()) {
      this.log.log(
        'Playwright-парсер выдачи выключен (PRICE_SOURCE=travelpayouts).',
      );
      return;
    }
    const headless =
      String(this.config.get('PLAYWRIGHT_HEADLESS', 'true')).toLowerCase() !==
      'false';
    const channel = (
      this.config.get<string>('PLAYWRIGHT_CHANNEL') ?? ''
    ).trim();

    const launchOpts: Parameters<typeof chromium.launch>[0] = {
      headless,
      ignoreDefaultArgs: ['--enable-automation'],
      args: [
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--window-size=1440,900',
      ],
    };
    if (channel) launchOpts.channel = channel as NonNullable<(typeof launchOpts)['channel']>;

    this.browser = await chromium.launch(launchOpts);
    await this.bootstrapBrowserContext();

    this.log.log(
      `Playwright: Авиасейлс и Купибилет (${channel ? `channel=${channel}` : 'chromium'})`,
    );
  }

  private async bootstrapBrowserContext(): Promise<void> {
    if (!this.browser || this.browserContext) return;

    const statePathRaw = (
      this.config.get<string>('PLAYWRIGHT_STORAGE_STATE_PATH') ?? ''
    ).trim();
    const statePath =
      statePathRaw && existsSync(statePathRaw) ? statePathRaw : undefined;

    if (statePathRaw && !statePath) {
      this.log.warn(
        `PLAYWRIGHT_STORAGE_STATE_PATH=${statePathRaw} — файла нет. При капче: npm run aviasales:auth`,
      );
    } else if (statePath) {
      this.log.log(`Сессия: ${statePath}`);
    }

    const ua =
      this.config.get<string>('AVIASALES_USER_AGENT') ??
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

    this.browserContext = await this.browser.newContext({
      locale: 'ru-RU',
      timezoneId: 'Europe/Moscow',
      viewport: { width: 1440, height: 900 },
      userAgent: ua,
      deviceScaleFactor: 1,
      hasTouch: false,
      ...(statePath ? { storageState: statePath } : {}),
    });

    await this.browserContext.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.browserContext?.close().catch(() => undefined);
    this.browserContext = null;
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
  }

  /**
   * Открывает URL выдачи, ждёт рендер SPA, парсит цены перевозчиков.
   * @param options.screenshot — дополнительно снять JPEG (тяжелее по памяти).
   */
  fetchSearchCarrierPrices(
    searchUrl: string,
    options?: { screenshot?: boolean; site?: FlightListingSite },
  ): Promise<AviasalesVisualSnapshot> {
    const site =
      options?.site ?? inferFlightListingSiteFromUrl(searchUrl);
    const task = this.runFetch(searchUrl, Boolean(options?.screenshot), site);
    const p = this.captureLock.then(() => task);
    this.captureLock = p.then(() => undefined, () => undefined);
    return p;
  }

  /** @deprecated используйте fetchSearchCarrierPrices */
  captureSearchPage(url: string): Promise<AviasalesVisualSnapshot> {
    return this.fetchSearchCarrierPrices(url);
  }

  isEnabled(): boolean {
    const src = (
      this.config.get<string>('PRICE_SOURCE') ?? 'aviasales_screenshot'
    ).toLowerCase();
    return src !== 'travelpayouts';
  }

  private async runFetch(
    searchUrl: string,
    takeScreenshot: boolean,
    site: FlightListingSite,
  ): Promise<AviasalesVisualSnapshot> {
    const fail = (msg: string): AviasalesVisualSnapshot => ({
      success: false,
      url: searchUrl,
      carrierPrices: [],
      error: msg,
    });

    if (!this.browser) return fail('Playwright не запущен');
    if (!this.browserContext) await this.bootstrapBrowserContext();
    if (!this.browserContext) return fail('Нет контекста браузера');

    const afterLoadWaitMs = Number(
      site === 'kupibilet'
        ? this.config.get('KUPIBILET_RENDER_WAIT_MS', 9000)
        : this.config.get('AVIASALES_RENDER_WAIT_MS', 8000),
    );
    const pauseMs = Number.isFinite(afterLoadWaitMs)
      ? Math.min(120_000, Math.max(3_000, afterLoadWaitMs))
      : 8000;

    const gotoTimeoutCfg = Number(
      site === 'kupibilet'
        ? this.config.get('KUPIBILET_GOTO_TIMEOUT_MS', '120000')
        : this.config.get('AVIASALES_GOTO_TIMEOUT_MS', '120000'),
    );
    const gotoTimeout =
      Number.isFinite(gotoTimeoutCfg) &&
      gotoTimeoutCfg >= 10_000 &&
      gotoTimeoutCfg <= 300_000
        ? gotoTimeoutCfg
        : 120_000;

    const page = await this.browserContext.newPage();
    try {
      const navOpts = {
        waitUntil: 'domcontentloaded' as const,
        timeout: gotoTimeout,
      };
      try {
        await page.goto(searchUrl, navOpts);
      } catch (first) {
        const isTimeout =
          first instanceof Error && /timeout|exceeded/i.test(first.message);
        if (!isTimeout) throw first;
        this.log.warn(
          `goto таймаут, повтор: ${shortenPlaywrightErrorMessage(first.message)}`,
        );
        await new Promise<void>((r) => setTimeout(r, 2_500));
        await page.goto(searchUrl, navOpts);
      }
      await new Promise<void>((r) => setTimeout(r, pauseMs));

      const pageText =
        ((await page.evaluate(
          () => document.body.innerText.slice(0, 400_000),
        )) as string) ?? '';

      if (suggestsCaptchaBlocking(pageText)) {
        return fail(
          'Капча/антибот. PLAYWRIGHT_CHANNEL=chrome, aviasales:auth, или PRICE_SOURCE=travelpayouts.',
        );
      }

      const carrierPrices: CarrierRubPrice[] = carrierRowsFromPageInnerText(
        site,
        pageText,
        searchUrl,
      ).map((r) => ({
        carrier: r.carrier,
        price: r.price,
        departureTime: r.departureTime,
        returnDepartureTime: r.returnDepartureTime,
      }));

      let screenshot: Buffer | undefined;
      if (takeScreenshot) {
        try {
          const fullCfg =
            site === 'kupibilet'
              ? 'KUPIBILET_FULL_PAGE_SCREENSHOT'
              : 'AVIASALES_FULL_PAGE_SCREENSHOT';
          const fullPage =
            String(this.config.get(fullCfg, 'false')).toLowerCase() === 'true';
          screenshot = Buffer.from(
            await page.screenshot({
              type: 'jpeg',
              quality: 80,
              fullPage,
            }),
          );
        } catch {
          /* скриншот не удался — остаёмся на тексте */
        }
      }

      const out: AviasalesVisualSnapshot = {
        success: true,
        url: searchUrl,
        carrierPrices,
      };
      if (screenshot !== undefined && screenshot.length > 512) out.screenshot = screenshot;
      return out;
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      this.log.warn(stripAnsi(raw));
      return fail(shortenPlaywrightErrorMessage(raw));
    } finally {
      await page.close().catch(() => undefined);
    }
  }
}
