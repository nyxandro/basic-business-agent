// How full a conversation is (spec, section 8.34). «Память» is not said: it is taken by the memory of a project and
// one's own.
export const contextFillTexts = {
  title: 'Длина разговора',
  label: (percent: number) => `Длина разговора: ${percent}%`,
  tokens: (used: string, limit: string) => `${used} из ${limit} токенов`,
  hidden: 'Начало разговора агент уже не видит',
  high: 'Скоро разговор не поместится в модель. Начните новый — важное о вас агент помнит.',
} as const;
