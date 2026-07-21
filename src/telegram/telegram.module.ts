import { Module } from '@nestjs/common';
import { AviasalesModule } from '../aviasales/aviasales.module';
import { CitiesModule } from '../cities/cities.module';
import { PricesModule } from '../prices/prices.module';
import { TelegramService } from './telegram.service';

@Module({
  imports: [AviasalesModule, CitiesModule, PricesModule],
  providers: [TelegramService],
})
export class TelegramModule {}
