import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AviasalesModule } from './aviasales/aviasales.module';
import { CitiesModule } from './cities/cities.module';
import { PricesModule } from './prices/prices.module';
import { TelegramModule } from './telegram/telegram.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    AviasalesModule,
    CitiesModule,
    PricesModule,
    TelegramModule,
  ],
  controllers: [AppController],
})
export class AppModule {}
