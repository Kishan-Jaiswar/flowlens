import mongoose from 'mongoose';

export const OrderModel =
  mongoose.models.Order ?? mongoose.model('Order', new mongoose.Schema({ note: String }));

export const CustomerModel =
  mongoose.models.Customer ?? mongoose.model('Customer', new mongoose.Schema({ name: String }));
