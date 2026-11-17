// A folder of the person's computer given to a project (spec, section 8.25): the browser answers the agent's
// tools about it. The names of the tools, how the chat names them, and the hidden folder of the working
// folder where a file the agent reads is copied for the skills.
export const COMPUTER_TOOLS = {
  list: 'computer_folder_list',
  find: 'computer_folder_find',
  read: 'computer_folder_read',
} as const;

export const COMPUTER_SYSTEM = 'Компьютер';

export const COMPUTER_ACTION_TITLES: Record<(typeof COMPUTER_TOOLS)[keyof typeof COMPUTER_TOOLS], string> = {
  computer_folder_list: 'Список файлов в папке с компьютера',
  computer_folder_find: 'Поиск файлов в папке с компьютера',
  computer_folder_read: 'Чтение файла из папки с компьютера',
};

// Inside the working folder of the conversation; hidden — not among «Файлы проекта», not stored (8.23).
export const COMPUTER_COPIES = '.computer';
