import { Controller, Get, Query } from '@nestjs/common';
import { ProductsService } from './products.service';

@Controller('products')
export class ProductsController {
  constructor(private readonly productsService: ProductsService) {}

  @Get()
  search(@Query('q') q: string) {
    return this.productsService.search(q ?? '');
  }

  /** Nothing in the frontend calls this route. */
  @Get('expiring')
  expiring(@Query('days') days: string) {
    return this.productsService.expiringSoon(Number(days ?? 30));
  }
}
