import axios from 'axios';

/** The other caller of the same endpoint, on a different screen. */
export function CompleteButton({ appointmentId }) {
  const handleComplete = async () => {
    await axios.patch(`/api/appointments/${appointmentId}`, { is_complete: true });
  };
  return <button onClick={handleComplete}>Complete appointment</button>;
}
