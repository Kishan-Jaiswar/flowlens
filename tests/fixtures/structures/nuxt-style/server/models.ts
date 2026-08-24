import mongoose from 'mongoose';
export const ProductModel = mongoose.model('Product', new mongoose.Schema({ name: String }));
