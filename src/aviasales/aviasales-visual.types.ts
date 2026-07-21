export interface CarrierRubPrice {
  carrier: string;

  price: number | null;

  departureTime?: string | null;

  returnDepartureTime?: string | null;
}

export interface AviasalesVisualSnapshot {
  success: boolean;
  url: string;
  carrierPrices: CarrierRubPrice[];

  screenshot?: Buffer;
  error?: string;
}
