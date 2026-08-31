import axios from 'axios';

/** One of two screens that PATCH the same endpoint. */
export function RequestPaymentPopup({ shipmentId }) {
  const handleSkip = async () => {
    await axios.patch(`/api/shipments/${shipmentId}`, { paid: false });
  };
  return <button onClick={handleSkip}>Skip payment</button>;
}
