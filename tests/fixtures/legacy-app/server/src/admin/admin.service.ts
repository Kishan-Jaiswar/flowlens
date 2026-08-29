import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Customer, CustomerDocument } from './customer.schema';

@Injectable()
export class AdminService {
  constructor(
    @InjectModel(Customer.name) private readonly customerModel: Model<CustomerDocument>,
  ) {}

  async listCustomers() {
    return this.customerModel.find({ archived: false }).limit(50).lean();
  }

  async findCustomer(id: string) {
    return this.customerModel.findById(id).lean();
  }

  async updateNotes(id: string, notes: string) {
    return this.customerModel.findByIdAndUpdate(id, { notes });
  }
}
