import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { CreatePrescriptionDto } from './dto/create-prescription.dto';
import { PrescriptionsService } from './prescriptions.service';

@Controller('prescriptions')
export class PrescriptionsController {
  constructor(private readonly prescriptionsService: PrescriptionsService) {}

  @Post()
  create(@Body() dto: CreatePrescriptionDto) {
    return this.prescriptionsService.create(dto);
  }

  @Get(':patientId/latest')
  latest(@Param('patientId') patientId: string) {
    return this.prescriptionsService.latestForPatient(patientId);
  }
}
