// How the admin panel names the system skills of the core (spec, section 8.18): the files of the
// skills stay as their authors wrote them (in English), the admin reads Russian. Every folder of
// core/system-skills needs a line here, and every line a folder (core/skills-admin/system.ts).
export const SYSTEM_SKILL_TITLES: Record<string, { title: string; description: string }> = {
  docx: {
    title: 'Документы Word',
    description: 'Читает, создаёт и правит документы Word: договоры, КП, письма — с таблицами, оглавлением, колонтитулами, правками и комментариями. Старые .doc переводит в .docx.',
  },
  pptx: {
    title: 'Презентации PowerPoint',
    description: 'Читает, создаёт и правит презентации: слайды по шаблону или с нуля, графики, иконки; проверяет вид слайдов по картинкам. Старые .ppt переводит в .pptx.',
  },
  xlsx: {
    title: 'Таблицы Excel',
    description: 'Читает, создаёт и правит таблицы: формулы, форматы, графики; пересчитывает формулы и проверяет ошибки. Работает и с CSV.',
  },
  pdf: {
    title: 'PDF',
    description: 'Читает текст и таблицы PDF, распознаёт сканы, создаёт PDF, объединяет и разделяет файлы, заполняет формы.',
  },
};
