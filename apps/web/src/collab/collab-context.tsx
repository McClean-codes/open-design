import { createContext, useContext, type ReactNode } from 'react';
import type { AnchorWriteBack } from '../comments';
import type { ProjectCollab } from './useProjectCollab';

// Shares the project's collab state (from useProjectCollab in ProjectView) down
// to deep descendants (FileViewer's comment overlay) without prop-threading
// through the big intermediate components, and without a second collab client.

export interface CollabContextValue extends ProjectCollab {
  /** Persist a drifted-to-`lost` comment's last-good position (needs the active
   * conversation id, which only ProjectView has). Absent when unavailable. */
  onLostAnchors?: (writeBacks: AnchorWriteBack[]) => void;
}

const DISABLED: CollabContextValue = {
  enabled: false,
  member: null,
  present: [],
  publishedVersion: null,
  syncState: null,
  viewerOnly: false,
  isOwner: false,
  isEffectiveOwner: false,
  isSharedNonOwner: false,
  ownerDisplayName: null,
  ownerRole: null,
  downloadPending: false,
  reportChange: () => {},
  requestPublish: () => {},
  refreshPresence: () => {},
  checkStatusNow: () => {},
};

const CollabContext = createContext<CollabContextValue>(DISABLED);

export function CollabProvider({ value, children }: { value: CollabContextValue; children: ReactNode }) {
  return <CollabContext.Provider value={value}>{children}</CollabContext.Provider>;
}

/** The current project's collab state; disabled default outside a provider. */
export function useProjectCollabContext(): CollabContextValue {
  return useContext(CollabContext);
}
