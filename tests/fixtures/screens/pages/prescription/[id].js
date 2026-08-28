import { useEffect, useState } from 'react';
import axios from 'axios';

/** A screen that fetches on mount and has one labelled button. */
export default function PrescriptionScreen({ id }) {
  const [rx, setRx] = useState(null);

  useEffect(() => {
    loadRx();
  }, [id]);

  const loadRx = async () => {
    const { data } = await axios.get(`/api/prescriptions/${id}`);
    setRx(data);
  };

  const handleSubmit = async () => {
    await axios.post('/api/prescriptions', rx);
  };

  return (
    <form>
      <button onClick={handleSubmit}>Submit</button>
    </form>
  );
}
