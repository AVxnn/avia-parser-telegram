import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const CITIES_URL = 'https://api.travelpayouts.com/data/ru/cities.json';

interface TravelpayoutCity {
  code?: string;
  name?: string;
  name_translations?: Record<string, string>;
  cases?: Record<string, string>;
}

function norm(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function labelsForCity(c: TravelpayoutCity): string[] {
  const out: string[] = [];
  if (c.name) out.push(c.name);
  if (c.name_translations)
    Object.values(c.name_translations).forEach((v) => v && out.push(v));
  if (c.cases)
    Object.values(c.cases).forEach((v) => v && out.push(v));
  return out;
}

@Injectable()
export class CitiesService implements OnModuleInit {
  private readonly log = new Logger(CitiesService.name);
  private loadPromise!: Promise<void>;
  private readonly byCode = new Map<
    string,
    { code: string; name: string }
  >();
  private readonly normToCode = new Map<string, string>();

  constructor(private readonly http: HttpService) {}

  onModuleInit(): void {
    this.loadPromise = this.loadCatalog();
  }

  async resolveCity(raw: string): Promise<{ code: string; name: string } | null> {
    await this.loadPromise;
    const query = raw.trim();
    if (!query) return null;
    const iataGuess = /^[a-z]{3}$/i.test(query);
    if (iataGuess) {
      const code = query.toUpperCase();
      const known = this.byCode.get(code);
      if (!known) return null;
      return known;
    }
    const key = norm(query);
    const direct = this.normToCode.get(key);
    if (direct) {
      const meta = this.byCode.get(direct)!;
      return meta;
    }
    if (key.length < 4) return null;
    const buckets: Array<{ nk: string; code: string }> = [];
    for (const [nk, cd] of this.normToCode) {
      if (nk.includes(key)) buckets.push({ nk, code: cd });
    }
    if (!buckets.length) return null;
    buckets.sort(
      (a, b) =>
        Math.abs(a.nk.length - key.length) - Math.abs(b.nk.length - key.length) ||
        a.nk.length - b.nk.length,
    );
    const cd = buckets[0].code;
    return this.byCode.get(cd)!;
  }

  private async loadCatalog(): Promise<void> {
    const { data } = await firstValueFrom(
      this.http.get<TravelpayoutCity[]>(CITIES_URL, {
        validateStatus: (s) => s === 200,
      }),
    );
    let count = 0;
    for (const row of data) {
      const code = (row.code ?? '').trim().toUpperCase();
      if (!code) continue;
      const name =
        typeof row.name === 'string' && row.name.trim()
          ? row.name.trim()
          : code;
      this.byCode.set(code, { code, name });
      for (const lbl of labelsForCity(row)) {
        const n = norm(lbl);
        if (n.length && !this.normToCode.has(n)) this.normToCode.set(n, code);
      }
      count += 1;
    }
    this.log.log(`Справочник городов загружен: ${count}`);
  }
}
