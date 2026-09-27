import { create } from 'zustand';

// ──────────────────────────────────────────
// UI Store
// Cross-component UI state that isn't route params.
//
// pendingRoomSelect:
//   Set by the search widget's "Open Room" action. The Home screen consumes
//   it on focus and selects that room (room tiles + boxes list live on Home,
//   so "opening a room" means selecting it there). Null when nothing pending.
// ──────────────────────────────────────────

interface UiState {
  pendingRoomSelect: string | null;
  setPendingRoomSelect: (roomId: string | null) => void;
}

export const useUiStore = create<UiState>((set) => ({
  pendingRoomSelect: null,
  setPendingRoomSelect: (roomId) => set({ pendingRoomSelect: roomId }),
}));
