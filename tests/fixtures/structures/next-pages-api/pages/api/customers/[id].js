import mongoose from 'mongoose';

const Customer = mongoose.models.Customer || mongoose.model('Customer', new mongoose.Schema({ title: String }));

export default async function handler(req, res) {
  switch (req.method) {
    case 'PATCH':
      return res.json(await Customer.findByIdAndUpdate(req.query.id, req.body));
    case 'DELETE':
      return res.json(await Customer.deleteOne({ _id: req.query.id }));
    default:
      return res.status(405).end();
  }
}
