import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Product, ProductDocument } from './product.schema';

@Injectable()
export class ProductsService {
  constructor(
    @InjectModel(Product.name) private readonly productModel: Model<ProductDocument>,
  ) {}

  /** Called by OrdersService — a shared dependency FlowLens surfaces. */
  async assertAvailable(productIds: string[]) {
    const count = await this.productModel.countDocuments({
      _id: { $in: productIds },
      stock: { $gt: 0 },
    });
    if (count !== productIds.length) {
      throw new BadRequestException('one or more products are out of stock');
    }
  }

  async search(term: string) {
    return this.productModel.find({ brand: { $regex: term, $options: 'i' } }).limit(25).lean();
  }

  /** No frontend calls this — `flowlens doctor` lists it as a dead endpoint. */
  async expiringSoon(days: number) {
    const cutoff = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    return this.productModel.find({ expiryDate: { $lte: cutoff } }).lean();
  }
}
