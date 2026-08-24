import { Controller, Get, Param, Patch } from '@nestjs/common';

@Controller('api/patients')
export class PatientsController {
  @Get()
  list() { return []; }

  @Patch(':id/archive')
  archive(@Param('id') id: string) { return { id }; }
}
