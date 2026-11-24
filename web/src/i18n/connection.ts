// The chat without a connection to the server (review 24.11): it says so and tries again by itself (chat/runtime-recovery.ts).
export const connectionTexts = {
  lost: 'Нет связи с сервером. Пробую подключиться снова — сообщение можно будет отправить, как только связь вернётся.',
} as const;
