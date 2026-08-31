import { useEffect, useState } from 'react';
import axios from 'axios';

/** A screen that fetches on mount and has one labelled button. */
export default function OrderScreen({ id }) {
  const [order, setOrder] = useState(null);

  useEffect(() => {
    loadRx();
  }, [id]);

  const loadRx = async () => {
    const { data } = await axios.get(`/api/orders/${id}`);
    setOrder(data);
  };

  const handleSubmit = async () => {
    await axios.post('/api/orders', order);
  };

  return (
    <form>
      <button onClick={handleSubmit}>Submit</button>
    </form>
  );
}
