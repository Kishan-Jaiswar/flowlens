import mongoose from 'mongoose';

const Customer = mongoose.models.Customer || mongoose.model('Customer', new mongoose.Schema({ title: String }));

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const created = await Customer.create({ title: req.body.title });
    return res.json(created);
  }
  if (req.method === 'GET') {
    const all = await Customer.find({});
    return res.json(all);
  }
  res.status(405).end();
}
