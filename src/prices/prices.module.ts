import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { PricesService } from './prices.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 60_000, maxRedirects: 5 }),
  ],
  providers: [PricesService],
  exports: [PricesService],
})
export class PricesModule {}
