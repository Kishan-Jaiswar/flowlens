import axios from 'axios';

/** One of two screens that PATCH the same endpoint. */
export function RequestPaymentPopup({ appointmentId }) {
  const handleSkip = async () => {
    await axios.patch(`/api/appointments/${appointmentId}`, { paid: false });
  };
  return <button onClick={handleSkip}>Skip payment</button>;
}
