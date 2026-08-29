import axios from 'axios';
import { IoTrash } from 'react-icons/io5';

/** An icon with no text, no labelling prop and an inline arrow: unlabelled. */
export function IconBar({ shipmentId }) {
  return (
    <div>
      <IoTrash onClick={() => axios.delete(`/api/shipments/${shipmentId}`)} />
    </div>
  );
}
