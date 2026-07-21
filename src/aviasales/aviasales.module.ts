import { Module } from '@nestjs/common';
import { AviasalesScreenshotService } from './aviasales-screenshot.service';

@Module({
  providers: [AviasalesScreenshotService],
  exports: [AviasalesScreenshotService],
})
export class AviasalesModule {}
