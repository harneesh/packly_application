export interface Move {
  id: string;
  name: string;
  owner_id: string;
  invite_code: string;
  created_at: string;
}

export interface MoveMember {
  move_id: string;
  user_id: string;
}

export interface Room {
  id: string;
  move_id: string;
  name: string;
  /** Hand-picked room icon (migration 020). NULL = derive from the name. */
  emoji: string | null;
}

export interface Box {
  id: string;
  room_id: string;
  box_number: string;
  created_by: string;
  created_at: string;
  label_written: boolean;
  is_packed: boolean;
}

export interface Item {
  id: string;
  box_id: string;
  name: string;
  created_by: string;
  created_at: string;
}

export interface BoxPhoto {
  id: string;
  box_id: string;
  storage_path: string;
  sort_order: number;
  created_by: string;
  created_at: string;
}
