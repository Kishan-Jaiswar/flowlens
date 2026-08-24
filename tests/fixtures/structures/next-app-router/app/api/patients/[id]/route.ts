import { PatientModel } from '../../../../lib/models';

export async function GET(_request: Request, context: { params: { id: string } }) {
  return Response.json(await PatientModel.findById(context.params.id));
}

export async function DELETE(_request: Request, context: { params: { id: string } }) {
  return Response.json(await PatientModel.deleteOne({ _id: context.params.id }));
}
