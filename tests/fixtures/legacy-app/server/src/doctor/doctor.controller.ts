import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { DoctorService } from './doctor.service';

/**
 * The prefix is part of the controller path, exactly as in a Nest app with a
 * global prefix. The frontend calls `/api/doctor/patients` too, so FlowLens
 * must strip `/api` from both sides or nothing matches.
 */
@Controller('api/doctor')
export class DoctorController {
  constructor(private readonly doctorService: DoctorService) {}

  @Get('patients')
  list() {
    return this.doctorService.listPatients();
  }

  @Get('patients/:id')
  findOne(@Param('id') id: string) {
    return this.doctorService.findPatient(id);
  }

  @Patch('patients/:id')
  update(@Param('id') id: string, @Body() body: { notes: string }) {
    return this.doctorService.updateNotes(id, body.notes);
  }
}
