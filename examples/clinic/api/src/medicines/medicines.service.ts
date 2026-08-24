import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Medicine, MedicineDocument } from './medicine.schema';

@Injectable()
export class MedicinesService {
  constructor(
    @InjectModel(Medicine.name) private readonly medicineModel: Model<MedicineDocument>,
  ) {}

  /** Called by PrescriptionsService — a shared dependency FlowLens surfaces. */
  async assertAvailable(medicineIds: string[]) {
    const count = await this.medicineModel.countDocuments({
      _id: { $in: medicineIds },
      stock: { $gt: 0 },
    });
    if (count !== medicineIds.length) {
      throw new BadRequestException('one or more medicines are out of stock');
    }
  }

  async search(term: string) {
    return this.medicineModel.find({ brand: { $regex: term, $options: 'i' } }).limit(25).lean();
  }

  /** No frontend calls this — `flowlens doctor` lists it as a dead endpoint. */
  async expiringSoon(days: number) {
    const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return this.medicineModel.find({ expiryDate: { $lte: cutoff } }).lean();
  }
}
