import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { Customer, CustomerDocument } from '../customers/customer.schema';

/**
 * Bulk import writes straight to `customers`, bypassing CustomersService.
 *
 * This is the coupling `flowlens doctor` is built to surface: two services
 * writing the same collection means a change to the customer shape has to be
 * made in two places, and nothing in either file says so.
 */
@Injectable()
export class ImportsService {
  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    private readonly auditService: AuditService,
  ) {}

  async importCustomers(rows: Array<{ name: string; phone: string; age: number }>) {
    await this.customerModel.insertMany(
      rows.map((row) => ({ name: row.name, phone: row.phone, age: row.age })),
    );
    await this.auditService.record('customers.imported', rows.length);
    return { imported: rows.length };
  }
}
