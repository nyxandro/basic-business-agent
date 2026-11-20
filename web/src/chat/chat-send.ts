// Sending into the conversation from outside its input (spec, section 8.32: «Отправить агенту» of the marks in the
// document viewer) — by the same path as the input: waiting questions are let go, the conversation moves up in
// «Недавние», a broken answer keeps its mark. `send` gives false when nothing was sent: the agent answers.
import { createContext, useContext } from 'react';

export interface ChatSend {
  send: (text: string) => boolean;
  running: boolean;
}

export const ChatSendContext = createContext<ChatSend | null>(null);

// Null outside a conversation: the viewer of «Файлы проекта» and of the search sends nothing (F43).
export const useChatSend = (): ChatSend | null => useContext(ChatSendContext);
