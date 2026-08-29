import axios from 'axios';

/** The other caller of the same endpoint, on a different screen. */
export function CompleteButton({ shipmentId }) {
  const handleComplete = async () => {
    await axios.patch(`/api/shipments/${shipmentId}`, { is_complete: true });
  };
  return <button onClick={handleComplete}>Complete shipment</button>;
}
