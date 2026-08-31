import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { ShipmentsService } from './shipments.service';

@Controller('api')
export class ShipmentsController {
  constructor(private readonly shipmentsService: ShipmentsService) {}

  @Post('shipments')
  create(@Body() body: { shopId: string; notes: string }) {
    return this.shipmentsService.create(body);
  }

  @Get('stats')
  stats(@Query('from') from: string) {
    return this.shipmentsService.stats(from);
  }
}
