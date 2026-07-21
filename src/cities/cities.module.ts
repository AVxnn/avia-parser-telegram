import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { CitiesService } from './cities.service';

@Module({
  imports: [
    HttpModule.register({ timeout: 120_000, maxRedirects: 5 }),
  ],
  providers: [CitiesService],
  exports: [CitiesService],
})
export class CitiesModule {}
