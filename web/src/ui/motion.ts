// How things take their new places in the interface (decision of the owner 17.11): over one moment,
// with a soft start and end. The input and its files (chat/Attachments.tsx, AutoHeight.tsx) and the
// lists where a removed thing turns to sand (dissolve.ts) move alike.
export const MOVE_S = 0.36;
export const EASING = [0.4, 0, 0.2, 1] as const;
