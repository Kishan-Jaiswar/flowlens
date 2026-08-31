import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import { AdminService } from './admin.service';

/**
 * The prefix is part of the controller path, exactly as in a Nest app with a
 * global prefix. The frontend calls `/api/admin/customers` too, so FlowLens
 * must strip `/api` from both sides or nothing matches.
 */
@Controller('api/admin')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('customers')
  list() {
    return this.adminService.listCustomers();
  }

  @Get('customers/:id')
  findOne(@Param('id') id: string) {
    return this.adminService.findCustomer(id);
  }

  @Patch('customers/:id')
  update(@Param('id') id: string, @Body() body: { notes: string }) {
    return this.adminService.updateNotes(id, body.notes);
  }
}
