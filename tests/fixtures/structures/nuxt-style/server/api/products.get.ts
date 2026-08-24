import { ProductModel } from '../models';
export default async function () {
  return ProductModel.find({});
}
