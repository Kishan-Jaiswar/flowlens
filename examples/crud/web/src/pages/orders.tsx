import { OrderForm } from '../components/OrderForm';

/** The page that renders the order form, for the customer in the URL. */
export default function OrdersPage({ customerId }: { customerId: string }) {
  return <OrderForm customerId={customerId} />;
}
