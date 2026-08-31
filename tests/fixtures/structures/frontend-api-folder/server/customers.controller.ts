import { Controller, Get, Param, Patch } from '@nestjs/common';

@Controller('api/customers')
export class CustomersController {
  @Get()
  list() { return []; }

  @Patch(':id/archive')
  archive(@Param('id') id: string) { return { id }; }
}
