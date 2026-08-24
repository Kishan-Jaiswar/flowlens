import mongoose from 'mongoose';

export const OrderModel =
  mongoose.models.Order ?? mongoose.model('Order', new mongoose.Schema({ note: String }));

export const PatientModel =
  mongoose.models.Patient ?? mongoose.model('Patient', new mongoose.Schema({ name: String }));
