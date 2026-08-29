import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { AuditService } from '../common/audit.service';
import { ProductsService } from '../products/products.service';
import { CustomersService } from '../customers/customers.service';
import { CreateOrderDto } from './dto/create-order.dto';
import { Order, OrderDocument } from './order.schema';

@Injectable()
export class OrdersService {
  constructor(
    @InjectModel(Order.name)
    private readonly orderModel: Model<OrderDocument>,
    private readonly customersService: CustomersService,
    private readonly productsService: ProductsService,
    private readonly auditService: AuditService,
  ) {}

  /**
   * The flagship flow of the example: one click touches four collections
   * across three services.
   */
  async create(dto: CreateOrderDto) {
    await this.customersService.findById(dto.customerId);
    await this.productsService.assertAvailable(dto.products.map((item) => item.productId));

    const order = await this.orderModel.create({
      customerId: dto.customerId,
      products: dto.products,
      note: dto.note,
      couponCode: dto.couponCode,
      deliveryDays: dto.deliveryDays,
    });

    await this.auditService.record('order.created', order._id);
    return order;
  }

  async latestForCustomer(customerId: string) {
    return this.orderModel.findOne({ customerId }).sort({ createdAt: -1 }).lean();
  }
}
