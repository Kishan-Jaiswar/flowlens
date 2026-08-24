import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import { AppointmentsService } from './appointments.service';

@Controller('api')
export class AppointmentsController {
  constructor(private readonly appointmentsService: AppointmentsService) {}

  @Post('appointments')
  create(@Body() body: { clinicId: string; notes: string }) {
    return this.appointmentsService.create(body);
  }

  @Get('stats')
  stats(@Query('from') from: string) {
    return this.appointmentsService.stats(from);
  }
}
