import mongoose from 'mongoose';

const Patient = mongoose.models.Patient || mongoose.model('Patient', new mongoose.Schema({ title: String }));

export default async function handler(req, res) {
  if (req.method === 'POST') {
    const created = await Patient.create({ title: req.body.title });
    return res.json(created);
  }
  if (req.method === 'GET') {
    const all = await Patient.find({});
    return res.json(all);
  }
  res.status(405).end();
}
