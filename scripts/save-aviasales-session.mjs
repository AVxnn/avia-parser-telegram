
import { chromium } from 'playwright';
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { resolve } from 'node:path';

const outPath = resolve(
  process.env.PLAYWRIGHT_STORAGE_STATE_PATH || 'aviasales-storage.json',
);
const channel = (process.env.PLAYWRIGHT_CHANNEL || 'chrome').trim();
const url =
  process.env.AVIASALES_AUTH_URL || 'https://www.aviasales.ru/search/LED1205MOW1';

const browser = await chromium.launch({
  headless: false,
  channel,
  ignoreDefaultArgs: ['--enable-automation'],
  args: [
    '--disable-blink-features=AutomationControlled',
    '--disable-infobars',
    '--window-size=1440,900',
  ],
});

const context = await browser.newContext({
  locale: 'ru-RU',
  timezoneId: 'Europe/Moscow',
  viewport: { width: 1440, height: 900 },
  userAgent:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
});

await context.addInitScript(() => {
  Object.defineProperty(navigator, 'webdriver', {
    get: () => undefined,
  });
});

const page = await context.newPage();
console.log(`Открываю: ${url}`);
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });

const rl = readline.createInterface({ input, output });
await rl.question(
  'Дождись загрузки, реши капчу при необходимости, затем Enter для сохранения кук…\n',
);
await context.storageState({ path: outPath });
console.log(`Сохранено: ${outPath}`);
console.log('Добавь в .env: PLAYWRIGHT_STORAGE_STATE_PATH=' + outPath);
await rl.close();
await browser.close();
