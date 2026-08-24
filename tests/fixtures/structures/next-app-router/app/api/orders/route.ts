import { OrderModel } from '../../../lib/models';

export async function GET() {
  const orders = await OrderModel.find({});
  return Response.json(orders);
}

export async function POST(request: Request) {
  const body = await request.json();
  const created = await OrderModel.create({ note: body.note });
  return Response.json(created);
}
