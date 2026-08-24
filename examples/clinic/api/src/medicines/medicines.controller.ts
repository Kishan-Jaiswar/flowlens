import { Controller, Get, Query } from '@nestjs/common';
import { MedicinesService } from './medicines.service';

@Controller('medicines')
export class MedicinesController {
  constructor(private readonly medicinesService: MedicinesService) {}

  @Get()
  search(@Query('q') q: string) {
    return this.medicinesService.search(q ?? '');
  }

  /** Nothing in the frontend calls this route. */
  @Get('expiring')
  expiring(@Query('days') days: string) {
    return this.medicinesService.expiringSoon(Number(days ?? 30));
  }
}
