// Texts of the marks in the viewer (spec, section 8.32), in `ru` as `ru.marks`: ru.ts is near the limit of a file.
import type { MarkKind, MarkTool } from '../viewer/marks/types.ts';

const TOOL: Record<MarkKind, string> = { rect: 'прямоугольник', ellipse: 'овал', pen: 'карандаш', arrow: 'стрелка', highlight: 'выделенный текст' };
const capital = (word: string) => word.charAt(0).toUpperCase() + word.slice(1);

export const marksTexts = {
  toggle: 'Пометки',
  tools: 'Инструменты пометок',
  tool: (tool: MarkTool) => capital(TOOL[tool]),
  commentLabel: 'Комментарий к пометке',
  commentPlaceholder: 'Что здесь поправить?',
  done: 'Готово',
  remove: 'Удалить',
  list: (count: number) => `Пометки · ${count}`,
  expand: 'Развернуть список пометок',
  collapse: 'Свернуть список пометок',
  mark: (number: number) => `Пометка ${number}`,
  removeMark: (number: number) => `Удалить пометку ${number}`,
  page: (page: number) => `стр. ${page}`,
  noComment: 'Без комментария',
  send: 'Отправить агенту',
  sending: 'Отправляю…',
  busy: 'Агент отвечает — отправить можно после ответа',
  changed: 'Документ изменился — прежние пометки к нему убраны',
  noStorage: 'Браузер не даёт сохранить пометки: они пропадут, если закрыть просмотрщик',
  pictureName: (documentName: string) => `${documentName} (пометки).jpg`,
  prepareFailed: 'Не получилось подготовить пометки к отправке. Попробуйте ещё раз.',
  // The message to the agent (spec, section 8.32, «Сообщение»).
  message: {
    document: (name: string, count: number) => `Пометки к документу «${name}» — ${count}:`,
    picture: (name: string, count: number) => `Пометки к картинке «${name}» — ${count}:`,
    page: (page: number) => `Стр. ${page}`,
    tool: (tool: MarkKind) => TOOL[tool],
    toolFirst: (tool: MarkKind) => capital(TOOL[tool]),
    noComment: 'без комментария',
    under: 'Под пометкой',
    atArrow: 'У стрелки',
    selected: 'Выделено',
  },
};
