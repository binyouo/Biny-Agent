import { randomBytes } from "node:crypto";

export interface ImportedMessageIdentity {
  messageId: string;
  parentMessageId?: string;
  slotId: string;
}

/** A new linear identity namespace for one imported conversation. */
export function createImportedMessageIdentity(): () => ImportedMessageIdentity {
  let parentMessageId: string | undefined;
  return () => {
    const messageId = `msg_${randomBytes(12).toString("hex")}`;
    const identity = { messageId, parentMessageId, slotId: messageId };
    parentMessageId = messageId;
    return identity;
  };
}
