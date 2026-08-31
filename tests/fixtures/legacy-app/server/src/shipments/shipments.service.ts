import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Shipment, ShipmentDocument } from './shipment.schema';

@Injectable()
export class ShipmentsService {
  constructor(
    @InjectModel(Shipment.name)
    private readonly shipmentModel: Model<ShipmentDocument>,
  ) {}

  async create(input: { shopId: string; notes: string }) {
    return this.shipmentModel.create({
      shopId: input.shopId,
      notes: input.notes,
    });
  }

  async stats(from: string) {
    return this.shipmentModel.countDocuments({ createdAt: { $gte: from } });
  }
}
