// Demo agent: a general helper with the employee's personal notes (plugin example-notes).
// Listing a note is read-only; adding one waits for «Да» like every other action.
import { defineAgent } from '../../core/config/public/index.ts';

export default defineAgent({
  id: 'assistant',
  name: 'Общий помощник',
  description: 'Отвечает на вопросы, ведёт ваши заметки и читает прикреплённые документы.',
  model: 'main',
  plugins: ['example-notes'],
  readOnly: [],
  starters: ['Запиши заметку: позвонить поставщику в пятницу', 'Покажи мои заметки', 'Что ты умеешь?'],
  editable: { instructions: true, models: [] },
});
