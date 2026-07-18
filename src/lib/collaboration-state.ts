import type {
  CollaborationServerMessage,
  PresenceUser,
} from "../../shared/realtime-contracts.js";

export interface CollaborationLock {
  participantId: string;
  ownerId: string;
  ownerDisplayName: string;
  expiresAt: string;
}

export interface CollaborationPreview {
  participantId: string;
  ownerId: string;
  ownerDisplayName: string;
  startDate: string;
  endDate: string;
}

export interface CollaborationState {
  users: PresenceUser[];
  locks: Record<string, CollaborationLock>;
  previews: Record<string, CollaborationPreview>;
  invalidationVersion: number;
}

export const initialCollaborationState: CollaborationState = {
  users: [],
  locks: {},
  previews: {},
  invalidationVersion: 0,
};

export function reduceCollaborationMessage(
  state: CollaborationState,
  message: CollaborationServerMessage,
): CollaborationState {
  switch (message.type) {
    case "presence":
      return { ...state, users: message.users };
    case "drag.lock.granted":
    case "drag.lock.denied":
      return {
        ...state,
        locks: {
          ...state.locks,
          [message.participantId]: {
            participantId: message.participantId,
            ownerId: message.ownerId,
            ownerDisplayName: message.ownerDisplayName,
            expiresAt: message.expiresAt,
          },
        },
      };
    case "drag.preview":
      return {
        ...state,
        previews: {
          ...state.previews,
          [message.participantId]: message,
        },
      };
    case "drag.lock.released": {
      const locks = { ...state.locks };
      const previews = { ...state.previews };
      delete locks[message.participantId];
      delete previews[message.participantId];
      return { ...state, locks, previews };
    }
    case "entity.invalidated":
      return {
        ...state,
        invalidationVersion: state.invalidationVersion + 1,
      };
    default:
      return state;
  }
}

export function clearTransientCollaborationState(
  state: CollaborationState,
): CollaborationState {
  return { ...state, users: [], locks: {}, previews: {} };
}
