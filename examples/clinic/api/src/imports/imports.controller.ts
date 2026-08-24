import { Body, Controller, Post } from '@nestjs/common';
import { ImportsService } from './imports.service';

@Controller('imports')
export class ImportsController {
  constructor(private readonly importsService: ImportsService) {}

  /** Called by an internal admin tool, not by this frontend. */
  @Post('patients')
  importPatients(@Body() body: { rows: Array<{ name: string; phone: string; age: number }> }) {
    return this.importsService.importPatients(body.rows ?? []);
  }
}
