import { Controller, Get } from '@nestjs/common';
import { ShopService } from './shop.service';

@Controller('api/shop')
export class ShopController {
  constructor(private readonly shopService: ShopService) {}

  @Get('settings')
  settings() {
    return this.shopService.settings();
  }
}
