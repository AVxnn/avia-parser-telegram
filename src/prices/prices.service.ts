import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';

const CHEAP_URL = 'https://api.travelpayouts.com/v1/prices/cheap';

export interface CheapestResult {
  success: boolean;
  price: number | null;
  offer: Record<string, unknown> | null;
  error?: unknown;
  raw?: unknown;
}

@Injectable()
export class PricesService {
  constructor(
    private readonly http: HttpService,
    private readonly config: ConfigService,
  ) {}

  async fetchCheapest(
    origin: string,
    destination: string,
    departIso: string,
    currency = 'rub',
  ): Promise<CheapestResult> {
    const token = this.config.getOrThrow<string>('TRAVELPAYOUTS_TOKEN');
    const { data, status } = await firstValueFrom(
      this.http.get<Record<string, unknown>>(CHEAP_URL, {
        headers: { 'x-access-token': token },
        params: {
          origin: origin.toUpperCase(),
          destination: destination.toUpperCase(),
          depart_date: departIso,
          currency: currency.toLowerCase(),
        },
        validateStatus: () => true,
      }),
    );
    if (status === 401) {
      throw new Error('TRAVELPAYOUTS_TOKEN недействителен или не задан');
    }
    if (status >= 400) {
      return {
        success: false,
        price: null,
        offer: null,
        error: `HTTP ${status}`,
        raw: data,
      };
    }
    const j = data;
    if (!j.success) {
      return {
        success: false,
        price: null,
        offer: null,
        error: j.error,
        raw: j,
      };
    }
    const destKey = destination.toUpperCase();
    const block = (j.data as Record<string, unknown> | undefined)?.[destKey];
    const offer = firstOffer(block);
    const price =
      offer && typeof offer.price === 'number' ? offer.price : null;
    return { success: true, price, offer, raw: j };
  }
}

function firstOffer(block: unknown): Record<string, unknown> | null {
  if (!block || typeof block !== 'object') return null;
  const o = block as Record<string, unknown>;
  const keys = Object.keys(o)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b);
  for (const k of keys) {
    const item = o[String(k)];
    if (item && typeof item === 'object' && 'price' in (item as object))
      return item as Record<string, unknown>;
  }
  return null;
}
