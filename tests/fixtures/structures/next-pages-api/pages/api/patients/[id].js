import mongoose from 'mongoose';

const Patient = mongoose.models.Patient || mongoose.model('Patient', new mongoose.Schema({ title: String }));

export default async function handler(req, res) {
  switch (req.method) {
    case 'PATCH':
      return res.json(await Patient.findByIdAndUpdate(req.query.id, req.body));
    case 'DELETE':
      return res.json(await Patient.deleteOne({ _id: req.query.id }));
    default:
      return res.status(405).end();
  }
}
