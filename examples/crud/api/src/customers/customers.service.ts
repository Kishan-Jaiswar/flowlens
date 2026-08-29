import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { Customer, CustomerDocument } from './customer.schema';

@Injectable()
export class CustomersService {
  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
    private readonly auditService: AuditService,
  ) {}

  async create(dto: CreateCustomerDto) {
    const customer = await this.customerModel.create({
      name: dto.name,
      phone: dto.phone,
      age: dto.age,
      notes: dto.notes,
    });
    await this.auditService.record('customer.created', customer._id);
    return customer;
  }

  async search(query: string) {
    return this.customerModel
      .find({ name: { $regex: query, $options: 'i' }, archived: false })
      .limit(50)
      .lean();
  }

  async findById(id: string) {
    const customer = await this.customerModel.findById(id).lean();
    if (!customer) throw new NotFoundException('customer not found');
    return customer;
  }

  async archive(id: string) {
    await this.customerModel.findByIdAndUpdate(id, { archived: true });
    await this.auditService.record('customer.archived', id);
  }

  async remove(id: string) {
    await this.customerModel.deleteOne({ _id: id });
    await this.auditService.record('customer.deleted', id);
  }
}
