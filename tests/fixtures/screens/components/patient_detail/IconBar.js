import axios from 'axios';
import { IoTrash } from 'react-icons/io5';

/** An icon with no text, no labelling prop and an inline arrow: unlabelled. */
export function IconBar({ appointmentId }) {
  return (
    <div>
      <IoTrash onClick={() => axios.delete(`/api/appointments/${appointmentId}`)} />
    </div>
  );
}
