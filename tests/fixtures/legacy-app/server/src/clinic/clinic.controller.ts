import { Controller, Get } from '@nestjs/common';
import { ClinicService } from './clinic.service';

@Controller('api/clinic')
export class ClinicController {
  constructor(private readonly clinicService: ClinicService) {}

  @Get('settings')
  settings() {
    return this.clinicService.settings();
  }
}
